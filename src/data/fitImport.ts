/**
 * Single-file FIT / GPX / TCX activity importer.
 *
 * Pipeline:
 *   1. Parse binary FIT (via `fit-file-parser`) or XML (GPX/TCX via DOMParser)
 *      into a common intermediate `StreamRecord` shape.
 *   2. Run the shared enrichment helpers from `activityEnrichment.ts` to
 *      compute iTRIMP, HR zones, power curve, polyline, km splits.
 *   3. Build a `GarminActivityRow` with id prefix `import-` so dedup keys
 *      cannot collide with `apple-`, `strava-`, or `garmin-` prefixed rows.
 *   4. Pass the row to `matchAndAutoComplete()` — same final step as all
 *      other activity sources.
 *
 * Reuse note (STRAVALESS_PLAN.md §A / §D):
 *   - The Garmin activityDetails parser (item A) receives per-second HR,
 *     power, GPS samples from JSON. Wire it into `streamsToActivityRow()`
 *     directly — that function is the canonical mapping layer.
 *   - The Strava archive ZIP path (item D) produces the same stream shape
 *     from .fit files inside the archive. Call `parseFit()` + `streamsToActivityRow()`.
 *
 * TODO(onboarding): reuse importActivityFile() in the wizard so a first-time
 *   user with only a FIT file can bootstrap the plan without any connected source.
 */

import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import {
  computeHREnrichment,
  computePowerStats,
  computeNPAndPowerCurve,
  resolveMaxHR,
  type PowerSample,
} from '@/data/activityEnrichment';
import { calculateZones } from '@/calculations/heart-rate';
import {
  buildPolylineFromLocations,
  extractKmSplits,
  extractBestEfforts,
  type SyntheticBestEffort,
} from '@/data/appleHealthRoute';
import type { RouteLocation } from '@/data/healthExtras';
import { getMutableState, saveState } from '@/state';
import { render } from '@/ui/renderer';
import { unzipSync, gunzipSync } from 'fflate';
// Shared with Apple Health so import + the primary source stay in parity:
// aggregateHistoryFromRows recomputes weekly baselines/CTL/archetype/PBs from a
// set of rows; applyPBsFromRows merges fastest-wins best efforts into s.pbs.
import { aggregateHistoryFromRows, applyPBsFromRows } from '@/data/appleHealthSync';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';

// ---------------------------------------------------------------------------
// Common intermediate types
// ---------------------------------------------------------------------------

/**
 * A single data record from a stream — one row per second (FIT) or one
 * trackpoint per GPS recording. All fields optional; caller fills what the
 * file provides.
 */
export interface StreamRecord {
  /** ISO-8601 timestamp or epoch ms string */
  timestamp: string;
  heartRate?: number;
  power?: number;
  /** Decimal degrees */
  lat?: number;
  lng?: number;
  /** Cumulative metres from start */
  distanceM?: number;
  cadence?: number;
}

/**
 * Top-level activity summary parsed from the file.
 * Supplements the stream when the file carries explicit summary fields
 * (FIT session message, TCX <TotalTimeSeconds>, etc.).
 */
export interface ActivitySummary {
  startTimeISO: string;
  /** seconds */
  durationSec: number;
  /** metres */
  distanceM: number | null;
  activityType: GarminActivityRow['activity_type'];
  calories?: number | null;
  /** Average HR from summary message (used when stream is absent) */
  avgHR?: number | null;
  maxHR?: number | null;
}

// ---------------------------------------------------------------------------
// Activity type mapping
// ---------------------------------------------------------------------------

/**
 * Map FIT Sport strings and GPX/TCX type hints to the internal activity_type
 * used by GarminActivityRow. Mirrors `mapWorkoutType` in appleHealthSync.ts
 * so both sources land in the same bucket.
 */
export function mapFitSport(sport: string | undefined, subSport?: string): GarminActivityRow['activity_type'] {
  const s = (sport ?? '').toLowerCase();
  const sub = (subSport ?? '').toLowerCase();

  if (s === 'running') {
    if (sub === 'treadmill' || sub === 'indoor_running') return 'TREADMILL_RUNNING';
    if (sub === 'trail') return 'TRAIL_RUNNING';
    return 'RUNNING';
  }
  if (s === 'cycling' || s === 'biking' || s === 'bike') {
    if (sub === 'indoor_cycling' || sub === 'spin') return 'INDOOR_CYCLING';
    return 'CYCLING';
  }
  if (s === 'swimming') {
    if (sub === 'open_water') return 'OPEN_WATER_SWIMMING';
    return 'SWIMMING';
  }
  if (s === 'walking') return 'WALKING';
  if (s === 'hiking') return 'HIKING';
  if (s === 'rowing') return 'ROWING';
  if (s === 'training') {
    if (sub === 'strength_training') return 'STRENGTH_TRAINING';
    if (sub === 'cardio_training') return 'AEROBIC_TRAINING';
    return 'CARDIO';
  }
  if (s === 'fitness_equipment') {
    if (sub === 'elliptical') return 'ELLIPTICAL';
    if (sub === 'stair_climbing') return 'STAIR_CLIMBING';
    return 'CARDIO';
  }
  // FIT sport strings used by tennis, basketball, soccer, etc.
  if (s === 'tennis') return 'TENNIS';
  if (s === 'basketball') return 'BASKETBALL';
  if (s === 'soccer') return 'SOCCER';
  // Catch-all — routes to cross-training in the matcher rather than locomotion.
  return 'CARDIO';
}

// ---------------------------------------------------------------------------
// FIT parser
// ---------------------------------------------------------------------------

/**
 * Parse a FIT binary buffer into { summary, records }.
 *
 * Uses `fit-file-parser` (ESM / CJS). The library exposes a `parseAsync`
 * method that returns a `ParsedFit` object. We pull records from
 * `data.records` (list mode) which gives one object per data record message.
 *
 * FIT position_lat / position_long are stored in "semicircles" (2^31 per
 * 180°). Convert to decimal degrees: value * (180 / 2^31).
 */
/**
 * Coerce a fit-file-parser timestamp to an ISO string. The library returns
 * JS `Date` objects by default, but the rest of the pipeline treats
 * `startTimeISO` and record timestamps as strings (`.replace()` for the
 * garmin_id, best-efforts, date label). Handles Date | number(epoch) | string.
 */
export function toISO(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') return v;
  return new Date().toISOString();
}

export async function parseFit(buffer: ArrayBuffer): Promise<{ summary: ActivitySummary; records: StreamRecord[] }> {
  // Dynamic import keeps the large library out of the main bundle.
  const FitParser = (await import('fit-file-parser')).default;
  const parser = new FitParser({ mode: 'list' });
  const data = await parser.parseAsync(buffer);

  // Pull session summary (first session message is the activity summary).
  const session = data.sessions?.[0];
  const activity = data.activity;

  const startTime = toISO(
    session?.start_time
      ?? activity?.local_timestamp
      ?? data.records?.[0]?.timestamp
      ?? new Date(),
  );

  const durationSec = session?.total_elapsed_time != null
    ? Math.round(session.total_elapsed_time)
    : (data.records?.length
      ? (() => {
          const first = data.records[0].timestamp;
          const last = data.records[data.records.length - 1].timestamp;
          return Math.round((new Date(last).getTime() - new Date(first).getTime()) / 1000);
        })()
      : 0);

  const distanceM = session?.total_distance != null
    ? Math.round(session.total_distance)
    : null;

  const activityType = mapFitSport(session?.sport, session?.sub_sport);

  const summary: ActivitySummary = {
    startTimeISO: startTime,
    durationSec,
    distanceM,
    activityType,
    calories: session?.total_calories ?? null,
    avgHR: session?.avg_heart_rate ?? null,
    maxHR: session?.max_heart_rate ?? null,
  };

  // Convert per-record messages to StreamRecord[].
  const SEMICIRCLES_TO_DEG = 180 / 2_147_483_648;
  const records: StreamRecord[] = (data.records ?? []).map(r => {
    const rec: StreamRecord = { timestamp: toISO(r.timestamp) };
    if (r.heart_rate != null) rec.heartRate = r.heart_rate;
    if (r.power != null) rec.power = r.power;
    if (r.position_lat != null) rec.lat = r.position_lat * SEMICIRCLES_TO_DEG;
    if (r.position_long != null) rec.lng = r.position_long * SEMICIRCLES_TO_DEG;
    if (r.distance != null) rec.distanceM = r.distance;
    if (r.cadence != null) rec.cadence = r.cadence;
    return rec;
  });

  return { summary, records };
}

// ---------------------------------------------------------------------------
// Minimal XML extractor (works in Node + Browser, no DOMParser required)
// ---------------------------------------------------------------------------

/**
 * Minimal regex-based XML extractor. Handles well-formed GPX/TCX files with
 * simple tags and attributes. Not a full XML parser — does not handle CDATA,
 * processing instructions, or deeply nested namespace declarations. Sufficient
 * for the fitness-file formats we target.
 *
 * Design: DOMParser is browser-only and not available in Vitest's Node
 * environment. This regex approach is portable across both, keeps the module
 * dependency-free, and is easy to test inline.
 */

/** Extract all occurrences of <tagName ...>content</tagName> as raw strings. */
function xmlBlocks(xml: string, tagName: string): string[] {
  // Match any-namespace prefix: <tagName ...>, <ns:tagName ...>, </tagName>, </ns:tagName>
  const open = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Tag may appear as <tag>, <ns:tag>, <tag attr="...">, <ns:tag attr="...">
  const re = new RegExp(`<(?:[\\w.-]+:)?${open}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${open}>`, 'gi');
  const results: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[0]);
  }
  return results;
}

/** Extract first occurrence of <tagName>content</tagName> within a block. */
function xmlText(block: string, tagName: string): string | null {
  const open = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[\\w.-]+:)?${open}(?:\\s[^>]*)?>(.*?)</(?:[\\w.-]+:)?${open}>`, 'is');
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

/** Extract attribute value from an element opening tag. */
function xmlAttr(openTag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = re.exec(openTag);
  return m ? m[1] : null;
}

/** Extract just the opening tag of the first matching element. */
function xmlOpenTag(xml: string, tagName: string): string | null {
  const open = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<(?:[\\w.-]+:)?${open}(\\s[^>]*)?>`, 'i');
  const m = re.exec(xml);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------
// GPX parser (pure-regex, no DOMParser)
// ---------------------------------------------------------------------------

/**
 * Parse a GPX string into { summary, records }.
 *
 * GPX <trkpt> elements carry HR and power in various extension namespaces:
 *   - Garmin: <gpxtpx:hr> / <gpxtpx:cad> inside <extensions>
 *   - Some devices: <ns3:hr>, <ns3:cadence>
 *   - Power: <power> or <ns3:Watts>
 */
export function parseGpx(gpxStr: string): { summary: ActivitySummary; records: StreamRecord[] } {
  // Extract all <trkpt ...>...</trkpt> blocks
  const trkptBlocks = xmlBlocks(gpxStr, 'trkpt');
  const records: StreamRecord[] = [];

  for (const block of trkptBlocks) {
    // lat / lon are attributes of the opening <trkpt> tag
    const openTag = xmlOpenTag(block, 'trkpt') ?? block;
    const latStr = xmlAttr(openTag, 'lat');
    const lngStr = xmlAttr(openTag, 'lon');
    const lat = latStr ? parseFloat(latStr) : NaN;
    const lng = lngStr ? parseFloat(lngStr) : NaN;

    const timeVal = xmlText(block, 'time');
    if (!timeVal) continue;

    const rec: StreamRecord = {
      timestamp: timeVal,
      lat: isFinite(lat) ? lat : undefined,
      lng: isFinite(lng) ? lng : undefined,
    };

    // HR: try multiple tag-name variants (namespace-agnostic via regex helper)
    const hrStr = xmlText(block, 'hr') ?? xmlText(block, 'HeartRateBpm');
    if (hrStr) {
      const hr = parseInt(hrStr, 10);
      if (isFinite(hr) && hr > 0) rec.heartRate = hr;
    }

    // Power
    const powerStr = xmlText(block, 'power') ?? xmlText(block, 'Watts');
    if (powerStr) {
      const p = parseFloat(powerStr);
      if (isFinite(p) && p >= 0) rec.power = p;
    }

    // Cadence
    const cadStr = xmlText(block, 'cad') ?? xmlText(block, 'cadence') ?? xmlText(block, 'Cadence');
    if (cadStr) {
      const c = parseInt(cadStr, 10);
      if (isFinite(c) && c >= 0) rec.cadence = c;
    }

    records.push(rec);
  }

  // Detect sport from <type> element anywhere in the document
  const typeVal = xmlText(gpxStr, 'type') ?? '';
  const activityType = mapFitSport(typeVal.toLowerCase() || 'running');

  // Derive summary from records
  const firstTs = records[0]?.timestamp ?? new Date().toISOString();
  const lastTs = records[records.length - 1]?.timestamp ?? firstTs;
  const durationSec = Math.round(
    (new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 1000,
  );

  // Compute distance from lat/lng haversine chain
  let totalDistanceM = 0;
  let prev: StreamRecord | null = null;
  for (const r of records) {
    if (r.lat != null && r.lng != null && prev?.lat != null && prev?.lng != null) {
      totalDistanceM += haversineMetres(prev.lat, prev.lng, r.lat, r.lng);
    }
    r.distanceM = totalDistanceM;
    prev = r;
  }

  return {
    summary: {
      startTimeISO: firstTs,
      durationSec,
      distanceM: totalDistanceM > 0 ? Math.round(totalDistanceM) : null,
      activityType,
    },
    records,
  };
}

// ---------------------------------------------------------------------------
// TCX parser (pure-regex, no DOMParser)
// ---------------------------------------------------------------------------

/**
 * Parse a TCX string into { summary, records }.
 *
 * TCX <Trackpoint> elements carry:
 *   - <Time>          — ISO-8601
 *   - <HeartRateBpm><Value>
 *   - <DistanceMeters>
 *   - <Watts> or <ns3:Watts> for power
 *   - <Cadence>
 *   - <Position><LatitudeDegrees> / <LongitudeDegrees>
 */
export function parseTcx(tcxStr: string): { summary: ActivitySummary; records: StreamRecord[] } {
  const trackpoints = xmlBlocks(tcxStr, 'Trackpoint');
  const records: StreamRecord[] = [];

  for (const tp of trackpoints) {
    const timeVal = xmlText(tp, 'Time');
    if (!timeVal) continue;

    const rec: StreamRecord = { timestamp: timeVal };

    // HR — <HeartRateBpm><Value>N</Value></HeartRateBpm>
    const hrBpmBlock = xmlBlocks(tp, 'HeartRateBpm')[0];
    const hrVal = hrBpmBlock ? xmlText(hrBpmBlock, 'Value') : null;
    if (hrVal) {
      const hr = parseInt(hrVal, 10);
      if (isFinite(hr) && hr > 0) rec.heartRate = hr;
    }

    // Distance
    const distStr = xmlText(tp, 'DistanceMeters');
    if (distStr) {
      const d = parseFloat(distStr);
      if (isFinite(d) && d >= 0) rec.distanceM = d;
    }

    // Power — <Watts> or <ns3:Watts>
    const wattsStr = xmlText(tp, 'Watts');
    if (wattsStr) {
      const p = parseFloat(wattsStr);
      if (isFinite(p) && p >= 0) rec.power = p;
    }

    // Cadence
    const cadStr = xmlText(tp, 'Cadence');
    if (cadStr) {
      const c = parseInt(cadStr, 10);
      if (isFinite(c) && c >= 0) rec.cadence = c;
    }

    // Position
    const posBlock = xmlBlocks(tp, 'Position')[0];
    if (posBlock) {
      const latStr = xmlText(posBlock, 'LatitudeDegrees');
      const lngStr = xmlText(posBlock, 'LongitudeDegrees');
      if (latStr && lngStr) {
        const lat = parseFloat(latStr);
        const lng = parseFloat(lngStr);
        if (isFinite(lat) && isFinite(lng)) { rec.lat = lat; rec.lng = lng; }
      }
    }

    records.push(rec);
  }

  // Sport from <Activity Sport="..."> attribute
  const actOpenTag = xmlOpenTag(tcxStr, 'Activity') ?? '';
  const sport = xmlAttr(actOpenTag, 'Sport') ?? '';
  const activityType = mapFitSport(sport.toLowerCase() || 'running');

  // Summary
  const firstTs = records[0]?.timestamp ?? new Date().toISOString();
  const lastTs = records[records.length - 1]?.timestamp ?? firstTs;
  const durationSec = Math.round(
    (new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 1000,
  );

  // For TCX: prefer the <DistanceMeters> from the final trackpoint (cumulative).
  const finalDist = records[records.length - 1]?.distanceM ?? null;
  let totalDistanceM = finalDist;
  if (!totalDistanceM) {
    // Fallback: haversine chain from GPS coordinates
    let sum = 0;
    let prevR: StreamRecord | null = null;
    for (const r of records) {
      if (r.lat != null && r.lng != null && prevR?.lat != null && prevR?.lng != null) {
        sum += haversineMetres(prevR.lat, prevR.lng, r.lat, r.lng);
      }
      if (r.distanceM == null) {
        let cumDist = sum;
        if (prevR?.lat != null && prevR?.lng != null && r.lat != null && r.lng != null) {
          cumDist = sum; // already updated above
        }
        r.distanceM = cumDist;
      }
      prevR = r;
    }
    totalDistanceM = sum > 0 ? sum : null;
  }

  return {
    summary: {
      startTimeISO: firstTs,
      durationSec,
      distanceM: totalDistanceM != null ? Math.round(totalDistanceM) : null,
      activityType,
    },
    records,
  };
}

// ---------------------------------------------------------------------------
// Stream → GarminActivityRow mapping (pure, testable)
// ---------------------------------------------------------------------------

/**
 * Convert parsed streams into an enriched GarminActivityRow.
 * This is the canonical mapping layer for all imported activities —
 * Garmin activityDetails (item A) and Strava archive (item D) should
 * call this function once their parsers produce a { summary, records } pair.
 *
 * @param summary    Top-level activity summary (times, distance, type)
 * @param records    Per-point stream records (HR, power, GPS, distance)
 * @param restingHR  User resting HR from state (for iTRIMP)
 * @param userMaxHR  User max HR from state (for iTRIMP)
 * @param age        User age from state (for Tanaka fallback)
 * @param sex        User biological sex from state
 */
export function streamsToActivityRow(
  summary: ActivitySummary,
  records: StreamRecord[],
  restingHR: number | null,
  userMaxHR: number | null,
  age: number | null | undefined,
  sex: 'male' | 'female' | undefined,
): GarminActivityRow {
  // Build a stable, collision-safe ID using the start time.
  // Using `import-` prefix keeps it separate from apple-/strava-/garmin- rows.
  const idBase = summary.startTimeISO.replace(/[^0-9T]/g, '').slice(0, 15);
  const garminId = `import-${idBase}`;

  const resolvedMaxHR = resolveMaxHR(userMaxHR, age);

  const zones = calculateZones({
    maxHR: resolvedMaxHR ?? undefined,
    restingHR: restingHR ?? undefined,
    age: age ?? undefined,
  });

  // --- HR enrichment ---
  const hrValues: number[] = [];
  const timeOffsets: number[] = [];
  const t0 = new Date(summary.startTimeISO).getTime();

  for (const r of records) {
    if (r.heartRate == null) continue;
    const ts = new Date(r.timestamp).getTime();
    const offset = (ts - t0) / 1000;
    if (!isFinite(offset) || offset < 0) continue;
    hrValues.push(r.heartRate);
    timeOffsets.push(offset);
  }

  const hrEnrich = hrValues.length >= 2
    ? computeHREnrichment(hrValues, timeOffsets, restingHR, resolvedMaxHR, zones, sex)
    : null;

  // Use summary-level HR when stream is absent (common for TCX with aggregates)
  const avgHR = hrEnrich?.avgHR ?? summary.avgHR ?? null;
  const maxHR = hrEnrich?.maxHR ?? summary.maxHR ?? null;

  // --- Power enrichment (cycling only) ---
  const isRide = summary.activityType === 'CYCLING' || summary.activityType === 'INDOOR_CYCLING';
  let powerStats: { avg: number | null; max: number | null } = { avg: null, max: null };
  let npData: ReturnType<typeof computeNPAndPowerCurve> = { normalizedPowerW: null, powerCurve: null };
  const hasPowerStream = records.some(r => r.power != null);

  if (hasPowerStream) {
    const powerSamples: PowerSample[] = records
      .filter(r => r.power != null)
      .map(r => ({ value: r.power!, startDate: r.timestamp }));
    powerStats = computePowerStats(powerSamples);
    if (isRide) {
      npData = computeNPAndPowerCurve(powerSamples);
    }
  }

  // --- Route / polyline ---
  const routeLocations: RouteLocation[] = records
    .filter(r => r.lat != null && r.lng != null)
    .map(r => ({
      lat: r.lat!,
      lng: r.lng!,
      timestamp: r.timestamp,
      // FIT/GPX/TCX files don't always carry altitude/speed/course/accuracy.
      // Default to 0 — these fields are used for display only and fall back
      // gracefully when zero (polyline encoding + km-split math uses only
      // lat/lng/timestamp).
      altitude: 0,
      speed: 0,
      course: 0,
      horizontalAccuracy: 0,
      verticalAccuracy: 0,
    }));

  let polyline: string | null = null;
  let kmSplits: number[] | null = null;
  let bestEfforts: SyntheticBestEffort[] | null = null;
  const isRun = summary.activityType === 'RUNNING' || summary.activityType === 'TRAIL_RUNNING' || summary.activityType === 'TREADMILL_RUNNING';

  if (routeLocations.length >= 2) {
    polyline = buildPolylineFromLocations(routeLocations);
    kmSplits = extractKmSplits(routeLocations);
    if (isRun) {
      const efforts = extractBestEfforts(routeLocations, summary.startTimeISO);
      if (efforts.length > 0) bestEfforts = efforts;
    }
  }

  // --- Pace ---
  const distanceM = summary.distanceM;
  const durationSec = summary.durationSec;
  const avgPaceSecKm = distanceM && distanceM > 0 && durationSec > 0
    ? Math.round((durationSec / distanceM) * 1000)
    : null;

  const row: GarminActivityRow = {
    garmin_id: garminId,
    activity_type: summary.activityType,
    start_time: summary.startTimeISO,
    duration_sec: durationSec,
    distance_m: distanceM,
    avg_pace_sec_km: avgPaceSecKm,
    avg_hr: avgHR != null ? Math.round(avgHR) : null,
    max_hr: maxHR != null ? Math.round(maxHR) : null,
    calories: summary.calories ?? null,
    aerobic_effect: null,
    anaerobic_effect: null,
    garmin_rpe: null,
    iTrimp: hrEnrich?.iTrimp ?? null,
    hrZones: hrEnrich?.hrZones ?? null,
    polyline,
    kmSplits,
    averageWatts: powerStats.avg,
    maxWatts: powerStats.max,
    normalizedPowerW: npData.normalizedPowerW,
    powerCurve: npData.powerCurve,
    // deviceWatts=true when we have a real power stream (not estimated).
    // FIT/TCX/GPX power fields come from physical sensors — treat as device data.
    deviceWatts: powerStats.avg != null ? true : null,
    repData: null,
  };

  if (bestEfforts && bestEfforts.length > 0) {
    (row as any).best_efforts = bestEfforts;
  }

  return row;
}

// ---------------------------------------------------------------------------
// High-level entry point
// ---------------------------------------------------------------------------

/**
 * Parse a FIT, GPX, or TCX file and inject it into the activity pipeline.
 *
 * Returns a plain-text summary of the imported activity (e.g.
 * "Imported: 12.4 km run, Mon 26 May") or throws an Error with a
 * user-readable message on failure.
 *
 * TODO(onboarding): reuse importActivityFile() in the wizard so a first-time
 *   user with only a FIT file can bootstrap the plan without any connected source.
 */
export async function importActivityFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';

  let summary: ActivitySummary;
  let records: StreamRecord[];

  if (ext === 'fit') {
    const buf = await file.arrayBuffer();
    ({ summary, records } = await parseFit(buf));
  } else if (ext === 'gpx') {
    const text = await file.text();
    ({ summary, records } = parseGpx(text));
  } else if (ext === 'tcx') {
    const text = await file.text();
    ({ summary, records } = parseTcx(text));
  } else {
    // Content-sniff fallback: check if it looks like XML
    const text = await file.text();
    if (text.trim().startsWith('<') && text.includes('<trkpt')) {
      ({ summary, records } = parseGpx(text));
    } else if (text.trim().startsWith('<') && text.includes('<Trackpoint')) {
      ({ summary, records } = parseTcx(text));
    } else {
      throw new Error(`Unsupported file type "${file.name}". Upload a .fit, .gpx, or .tcx file.`);
    }
  }

  if (records.length === 0 && summary.durationSec === 0) {
    throw new Error(`Could not read activity data from "${file.name}". The file may be empty or corrupted.`);
  }

  // Resolve HR parameters from state
  const s = getMutableState();
  const restingHR = s.restingHR && s.restingHR > 0 ? s.restingHR : null;
  const userMaxHR = s.maxHR && s.maxHR > 0 ? s.maxHR : null;
  const age = s.onboarding?.age ?? null;
  const sex: 'male' | 'female' | undefined =
    s.biologicalSex === 'male' || s.biologicalSex === 'female' ? s.biologicalSex : undefined;

  const row = streamsToActivityRow(summary, records, restingHR, userMaxHR, age, sex);
  const changed = matchAndAutoComplete([row]);
  if (changed) {
    // A single imported run can beat a PB and shift blended fitness. Apply
    // best efforts (fastest-wins, improvement-only) and refresh the prediction
    // so the import actually moves the user's numbers, not just the week view.
    applyPBsFromRows([row]);
    try { refreshBlendedFitness(s); } catch (e) { console.warn('[Import] refreshBlendedFitness failed:', e); }
    saveState();
    render();
  }

  // Build a human-readable import summary
  const actLabel = formatActivityType(summary.activityType);
  const distKm = summary.distanceM ? (summary.distanceM / 1000).toFixed(1) : null;
  const dateLabel = formatDateLabel(summary.startTimeISO);
  const parts: string[] = [];
  if (distKm) parts.push(`${distKm} km`);
  parts.push(actLabel.toLowerCase());
  parts.push(dateLabel);

  return `Imported: ${parts.join(', ')}`;
}

export interface ArchiveImportResult {
  /** Distinct activities ingested (after de-duplication). */
  imported: number;
  /** Duplicate exports of the same activity that collapsed into one. */
  skipped: number;
  /** Files found but unreadable (corrupt / unsupported inner format). */
  failed: number;
  /** Human-readable one-liner for toast feedback. */
  summary: string;
}

/**
 * Ingest a full Strava or Garmin export archive (.zip) — the "bring all my
 * history" path. Handles both layouts we coach users toward:
 *   - Strava archive: a flat `activities/` folder of .gpx/.fit/.tcx, usually
 *     individually gzipped (`.fit.gz`, `.gpx.gz`, `.tcx.gz`).
 *   - Garmin full export: FIT files nested inside `UploadedFiles_*.zip` archives.
 *
 * Every activity file is parsed with the same single-file parser, batched
 * through `matchAndAutoComplete`, then the whole set is run through the shared
 * history aggregator (same path Apple Health uses) so weekly baselines, CTL,
 * archetype, detectedWeeklyKm and PBs all reflect the imported history — i.e.
 * the import actually drives the plan, not just the week views.
 *
 * Synchronous unzip (fflate) keeps v1 simple; a very large Garmin export may
 * briefly block the main thread. Streaming/worker decode is a future refinement.
 */
export async function importActivityArchive(
  file: File,
  onProgress?: (done: number, total: number) => void,
): Promise<ArchiveImportResult> {
  const buf = new Uint8Array(await file.arrayBuffer());

  const candidates: { name: string; data: Uint8Array }[] = [];
  collectArchiveEntries(buf, candidates);

  if (candidates.length === 0) {
    throw new Error('No activity files (.fit, .gpx, .tcx) found in that archive. Make sure you uploaded the export .zip from Strava or Garmin Connect.');
  }

  const s = getMutableState();
  const restingHR = s.restingHR && s.restingHR > 0 ? s.restingHR : null;
  const userMaxHR = s.maxHR && s.maxHR > 0 ? s.maxHR : null;
  const age = s.onboarding?.age ?? null;
  const sex: 'male' | 'female' | undefined =
    s.biologicalSex === 'male' || s.biologicalSex === 'female' ? s.biologicalSex : undefined;

  const rows: GarminActivityRow[] = [];
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      const parsed = await parseArchiveEntry(c.name, c.data);
      if (parsed && !(parsed.records.length === 0 && parsed.summary.durationSec === 0)) {
        rows.push(streamsToActivityRow(parsed.summary, parsed.records, restingHR, userMaxHR, age, sex));
      } else if (parsed) {
        failed++;
      }
    } catch {
      failed++;
    }
    onProgress?.(i + 1, candidates.length);
  }

  if (rows.length === 0) {
    throw new Error('Could not read any activities from that archive. The files may be in an unsupported format.');
  }

  // De-dup by garmin_id (start-time keyed) so the same activity exported twice
  // collapses to one row.
  const byId = new Map<string, GarminActivityRow>();
  for (const r of rows) byId.set(r.garmin_id, r);
  const deduped = [...byId.values()];

  matchAndAutoComplete(deduped);
  // Recompute baselines / fitness / archetype / PBs from the imported history.
  aggregateHistoryFromRows(deduped, { source: 'import' });
  try { refreshBlendedFitness(s); } catch (e) { console.warn('[ArchiveImport] refreshBlendedFitness failed:', e); }
  saveState();
  render();

  const imported = deduped.length;
  const skipped = rows.length - deduped.length;
  return {
    imported,
    skipped,
    failed,
    summary: `Imported ${imported} activit${imported === 1 ? 'y' : 'ies'}${failed > 0 ? `, ${failed} unreadable` : ''}.`,
  };
}

/**
 * Recursively collect activity-file entries from a zip, descending into nested
 * `.zip` entries (Garmin's `UploadedFiles_*.zip`). Depth-guarded.
 */
export function collectArchiveEntries(
  zipBytes: Uint8Array,
  out: { name: string; data: Uint8Array }[],
  depth = 0,
): void {
  if (depth > 3) return;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch {
    return; // not a valid zip at this level — skip
  }
  for (const [name, data] of Object.entries(entries)) {
    const lower = name.toLowerCase();
    if (lower.endsWith('/') || data.length === 0) continue;
    if (lower.endsWith('.zip')) {
      collectArchiveEntries(data, out, depth + 1);
    } else if (
      lower.endsWith('.fit') || lower.endsWith('.gpx') || lower.endsWith('.tcx') ||
      lower.endsWith('.fit.gz') || lower.endsWith('.gpx.gz') || lower.endsWith('.tcx.gz')
    ) {
      out.push({ name, data });
    }
  }
}

/** Parse one collected archive entry (transparently gunzipping `.gz`). */
export async function parseArchiveEntry(
  name: string,
  data: Uint8Array,
): Promise<{ summary: ActivitySummary; records: StreamRecord[] } | null> {
  let bytes = data;
  let lower = name.toLowerCase();
  if (lower.endsWith('.gz')) {
    bytes = gunzipSync(data);
    lower = lower.slice(0, -3);
  }
  if (lower.endsWith('.fit')) {
    return await parseFit(bytes.slice().buffer);
  }
  if (lower.endsWith('.gpx')) {
    return parseGpx(new TextDecoder().decode(bytes));
  }
  if (lower.endsWith('.tcx')) {
    return parseTcx(new TextDecoder().decode(bytes));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Haversine distance in metres between two points. */
function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Human-readable label for an activity type. */
function formatActivityType(type: GarminActivityRow['activity_type']): string {
  const map: Record<string, string> = {
    RUNNING: 'Run',
    TRAIL_RUNNING: 'Trail run',
    TREADMILL_RUNNING: 'Treadmill run',
    CYCLING: 'Ride',
    INDOOR_CYCLING: 'Indoor ride',
    SWIMMING: 'Swim',
    OPEN_WATER_SWIMMING: 'Open water swim',
    WALKING: 'Walk',
    HIKING: 'Hike',
    STRENGTH_TRAINING: 'Strength',
    CARDIO: 'Cardio',
    AEROBIC_TRAINING: 'Cardio',
  };
  return map[type] ?? type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/** Short day + month date label for display. */
function formatDateLabel(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
