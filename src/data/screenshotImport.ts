/**
 * Screenshot import. The iOS-easy capture path.
 *
 * A user screenshots their run summary (Strava / Garmin / Nike etc.) and we read
 * the numbers off it. Two engines feed the SAME structured contract
 * (`ParsedScreenshotActivity`):
 *   1. On-device OCR (free, private) → recognised text → `parseScreenshotText()`.
 *   2. AI vision fallback (when OCR confidence is low) → structured JSON →
 *      `parsedFromAIJson()`.
 * Both converge on `screenshotActivityToRow()` → the shared import pipeline
 * (match + PBs + fitness refresh), so a screenshot-sourced run drives the plan
 * exactly like a file import. Minus the GPS route (a screenshot has no track)
 * and at per-km, not per-second, granularity.
 *
 * This module is the verified core. The OCR engine (native Apple Vision plugin)
 * and the AI-vision edge function are separate pieces that PRODUCE the inputs
 * to the functions here.
 */

import { matchAndAutoComplete, healMissingITrimp, computeRollingRestingHR, type GarminActivityRow } from '@/calculations/activity-matcher';
import { applyPBsFromRows } from '@/data/appleHealthSync';
import { refreshBlendedFitness } from '@/calculations/blended-fitness';
import { getMutableState, saveState } from '@/state';
import { render } from '@/ui/renderer';
import { computeHREnrichment } from '@/data/activityEnrichment';
import { calculateZones, type HRZones } from '@/calculations/heart-rate';
import { resolveTrimpSex } from '@/calculations/trimp';

export interface ParsedScreenshotSplit {
  /** Split index in km (1, 2, ... ; a trailing partial may be < 1). */
  km: number;
  /** Pace for the split in seconds per km, or null if unreadable. */
  paceSecKm: number | null;
  /** Average HR over the split, or null. */
  hr: number | null;
}

export interface ParsedScreenshotHrPoint {
  /** Seconds since activity start. */
  tSec: number;
  /** Heart rate in bpm. */
  hr: number;
}

export interface ParsedScreenshotActivity {
  sport: 'RUNNING';
  /** Total distance in metres, or null if not found. */
  distanceM: number | null;
  /** Total moving/elapsed time in seconds, or null. */
  durationSec: number | null;
  avgPaceSecKm: number | null;
  avgHR: number | null;
  maxHR: number | null;
  splits: ParsedScreenshotSplit[];
  /**
   * Optional per-minute (or similar) HR samples from a separate HR-chart
   * screenshot, parsed by the AI-vision `hr_chart` mode. When present,
   * `screenshotActivityToRow` runs the canonical `computeHREnrichment` over
   * these points to produce iTRIMP + HR zones + maxHR exactly like a FIT-file
   * import. So a screenshot run can drive load math at full fidelity.
   */
  hrSeries?: ParsedScreenshotHrPoint[];
  /** Overall read confidence — drives whether we fall back to AI vision and how
   *  insistently the confirm screen asks the user to check the numbers. */
  confidence: 'high' | 'medium' | 'low';
  /** Key fields we could not read (e.g. 'distance', 'duration'). */
  missing: string[];
}

// ---------------------------------------------------------------------------
// Value parsing helpers
// ---------------------------------------------------------------------------

/** "42:34" → 2554, "1:23:45" → 5025. Returns null on garbage. */
export function parseClockToSec(s: string): number | null {
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10), c = m[3] != null ? parseInt(m[3], 10) : null;
  if (c != null) return a * 3600 + b * 60 + c; // h:mm:ss
  return a * 60 + b;                             // mm:ss
}

/** Distance string → metres. Handles km ("7.5") and mi ("4.66 mi"). */
function parseDistanceToM(value: string, unitHint: 'km' | 'mi'): number | null {
  const m = value.match(/(\d{1,3}(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0 || n > 500) return null;
  return Math.round(n * (unitHint === 'mi' ? 1609.34 : 1000));
}

// ---------------------------------------------------------------------------
// OCR text → structured activity
// ---------------------------------------------------------------------------

/**
 * Parse recognised OCR text (newline-separated visual lines, top-to-bottom)
 * into a structured activity. Keyword-anchored and tolerant of OCR noise. Never
 * throws. Returns a result with `confidence` + `missing` so callers can decide
 * whether to fall back to AI vision or surface a confirm screen.
 */
export function parseScreenshotText(raw: string): ParsedScreenshotActivity {
  const text = raw.replace(/\r/g, '');
  const flat = text.replace(/\n+/g, ' ');
  const low = flat.toLowerCase();
  const unitHint: 'km' | 'mi' = /\bmi\b|\/mi|miles/.test(low) && !/\bkm\b|\/km/.test(low) ? 'mi' : 'km';

  const grab = (re: RegExp): string | null => {
    const m = low.match(re);
    return m ? m[1] : null;
  };

  // Duration: prefer moving time, then elapsed/duration/time.
  const durStr =
    grab(/(?:moving\s*time)\D{0,12}(\d{1,2}:\d{2}(?::\d{2})?)/) ??
    grab(/(?:elapsed\s*time|duration|\btime\b)\D{0,12}(\d{1,2}:\d{2}(?::\d{2})?)/);
  const durationSec = durStr ? parseClockToSec(durStr) : null;

  const paceStr = grab(/(?:avg(?:erage)?\s*pace)\D{0,12}(\d{1,2}:\d{2})/);
  const avgPaceSecKm = paceStr ? parseClockToSec(paceStr) : null;

  const avgHrStr = grab(/(?:avg(?:erage)?\s*(?:heart\s*rate|hr))\D{0,14}(\d{2,3})/);
  const avgHR = avgHrStr ? clampHR(parseInt(avgHrStr, 10)) : null;

  const maxHrStr = grab(/(?:max(?:imum)?\s*(?:heart\s*rate|hr))\D{0,14}(\d{2,3})/);
  const maxHR = maxHrStr ? clampHR(parseInt(maxHrStr, 10)) : null;

  const distStr = grab(/(?:distance)\D{0,12}(\d{1,3}(?:\.\d{1,2})?)/);
  let distanceM = distStr ? parseDistanceToM(distStr, unitHint) : null;

  // Splits: lines like "1  5:30  7  131" → km, pace, (elev), HR(last number).
  const splits: ParsedScreenshotSplit[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d{1,2}(?:\.\d)?)\s+(\d{1,2}:\d{2})\b.*?(\d{2,3})\s*$/);
    if (!m) continue;
    const km = parseFloat(m[1]);
    if (!isFinite(km) || km <= 0 || km > 99) continue;
    const pace = parseClockToSec(m[2]);
    const hr = clampHR(parseInt(m[3], 10));
    if (pace == null || pace < 120 || pace > 1500) continue; // sane run pace 2:00–25:00 /km
    splits.push({ km, paceSecKm: pace, hr });
  }

  // Derive distance from splits if the header distance was unreadable.
  if (distanceM == null && splits.length > 0) {
    const kmSum = splits.reduce((a, s) => a + (s.km < 1 ? s.km : 1), 0);
    if (kmSum > 0) distanceM = Math.round(kmSum * 1000);
  }

  const missing: string[] = [];
  if (distanceM == null) missing.push('distance');
  if (durationSec == null) missing.push('duration');
  if (avgHR == null && splits.every(s => s.hr == null)) missing.push('heart rate');

  // Confidence: high needs distance + duration + an HR signal + a few splits.
  const hasHR = avgHR != null || splits.some(s => s.hr != null);
  let confidence: ParsedScreenshotActivity['confidence'];
  if (distanceM != null && durationSec != null && hasHR && splits.length >= 3) confidence = 'high';
  else if (distanceM != null && durationSec != null) confidence = 'medium';
  else confidence = 'low';

  return { sport: 'RUNNING', distanceM, durationSec, avgPaceSecKm, avgHR, maxHR, splits, confidence, missing };
}

function clampHR(n: number): number | null {
  return isFinite(n) && n >= 60 && n <= 240 ? n : null;
}

/**
 * Map structured JSON from the AI-vision fallback into the same contract. The
 * edge function is prompted to return this shape, so this is a thin, defensive
 * coercion (the AI is not trusted to return clean types).
 */
export function parsedFromAIJson(json: any): ParsedScreenshotActivity {
  const num = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
  const splits: ParsedScreenshotSplit[] = Array.isArray(json?.splits)
    ? json.splits
        .map((s: any) => ({ km: num(s?.km) ?? 0, paceSecKm: num(s?.paceSecKm), hr: clampHR(num(s?.hr) ?? NaN) }))
        .filter((s: ParsedScreenshotSplit) => s.km > 0)
    : [];
  const distanceM = num(json?.distanceM);
  const durationSec = num(json?.durationSec);
  const avgHR = clampHR(num(json?.avgHR) ?? NaN);
  const missing: string[] = [];
  if (distanceM == null) missing.push('distance');
  if (durationSec == null) missing.push('duration');
  if (avgHR == null && splits.every(s => s.hr == null)) missing.push('heart rate');
  return {
    sport: 'RUNNING',
    distanceM,
    durationSec,
    avgPaceSecKm: num(json?.avgPaceSecKm),
    avgHR,
    maxHR: clampHR(num(json?.maxHR) ?? NaN),
    splits,
    confidence: missing.length === 0 ? 'high' : missing.length === 1 ? 'medium' : 'low',
    missing,
  };
}

/**
 * Defensive coercion for the AI `hr_chart` mode response. Accepts an array of
 * `{ tSec, hr }` and drops anything that fails the sanity gates (negative time,
 * HR outside [60, 240]). Result is sorted ascending by tSec so downstream
 * integration sees the points in chronological order.
 */
export function parsedHrSeriesFromAIJson(json: any): ParsedScreenshotHrPoint[] {
  const raw = Array.isArray(json?.hrSeries) ? json.hrSeries : Array.isArray(json) ? json : [];
  const out: ParsedScreenshotHrPoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const tSec = typeof item.tSec === 'number' && isFinite(item.tSec) ? item.tSec : null;
    const hrRaw = typeof item.hr === 'number' && isFinite(item.hr) ? item.hr : null;
    const hr = hrRaw != null ? clampHR(hrRaw) : null;
    if (tSec == null || tSec < 0 || hr == null) continue;
    out.push({ tSec: Math.round(tSec), hr });
  }
  out.sort((a, b) => a.tSec - b.tSec);
  return out;
}

// ---------------------------------------------------------------------------
// Structured activity → activity row → pipeline
// ---------------------------------------------------------------------------

/**
 * Enrichment context for `screenshotActivityToRow`. When supplied AND the
 * parsed activity carries an `hrSeries`, the row builder runs the canonical
 * `computeHREnrichment` to produce iTRIMP + HR zones + maxHR exactly like a
 * FIT-file import. Without context, the builder falls back to the avgHR-only
 * heal path used before per-minute HR existed.
 *
 * Mirrors the parameters fitImport.ts passes to `computeHREnrichment`.
 */
export interface ScreenshotEnrichmentContext {
  restingHR: number | null;
  userMaxHR: number | null;
  sex: 'male' | 'female' | undefined;
  /** Pre-computed HR zones (caller can compute via `calculateZones`). Optional;
   *  zones are only needed for the zone-time breakdown. */
  zones?: HRZones;
}

/**
 * Build a `GarminActivityRow` from a confirmed screenshot activity. Per-minute
 * HR (when an `hrSeries` is present) is integrated through the same enrichment
 * helper file imports use; otherwise iTrimp is left null so the heal pass can
 * derive it from avg HR + duration.
 *
 * No polyline (a screenshot has no GPS track) and no per-second streams.
 */
export function screenshotActivityToRow(
  p: ParsedScreenshotActivity,
  startTimeISO: string,
  ctx?: ScreenshotEnrichmentContext,
): GarminActivityRow {
  const idBase = startTimeISO.replace(/[^0-9T]/g, '').slice(0, 15);
  const durationSec = p.durationSec ?? 0;
  const distanceM = p.distanceM ?? 0;
  const avgPace = p.avgPaceSecKm
    ?? (distanceM > 0 && durationSec > 0 ? Math.round((durationSec / distanceM) * 1000) : null);

  // Per-km pace splits (whole-km only) for the splits chart.
  const kmSplits = p.splits
    .filter(s => s.km >= 1 && s.paceSecKm != null)
    .sort((a, b) => a.km - b.km)
    .map(s => s.paceSecKm!);

  // Derive avg HR from splits if the summary value was missing.
  const splitHRs = p.splits.map(s => s.hr).filter((h): h is number => h != null);
  let avgHR = p.avgHR ?? (splitHRs.length ? Math.round(splitHRs.reduce((a, b) => a + b, 0) / splitHRs.length) : null);
  let maxHR = p.maxHR ?? (splitHRs.length ? Math.max(...splitHRs) : null);
  let iTrimp: number | null = null;
  let hrZones: GarminActivityRow['hrZones'] = null;

  // If a per-minute HR series came in from the AI hr_chart pass, run it through
  // the same enrichment helper FIT imports use. This produces a real iTRIMP and
  // zone-time breakdown for the screenshot run, instead of the coarse heal-pass
  // estimate that only knows avgHR + duration.
  if (p.hrSeries && p.hrSeries.length >= 2 && ctx) {
    const hrValues = p.hrSeries.map(s => s.hr);
    const timeOffsets = p.hrSeries.map(s => s.tSec);
    const enrich = computeHREnrichment(hrValues, timeOffsets, ctx.restingHR, ctx.userMaxHR, ctx.zones, ctx.sex);
    if (enrich) {
      avgHR = enrich.avgHR ?? avgHR;
      maxHR = enrich.maxHR ?? maxHR;
      iTrimp = enrich.iTrimp;
      hrZones = enrich.hrZones;
    }
  }

  return {
    garmin_id: `screenshot-${idBase}`,
    activity_type: p.sport,
    start_time: startTimeISO,
    duration_sec: durationSec,
    distance_m: distanceM,
    avg_pace_sec_km: avgPace,
    avg_hr: avgHR,
    max_hr: maxHR,
    calories: null,
    aerobic_effect: null,
    anaerobic_effect: null,
    garmin_rpe: null,
    iTrimp,                     // populated when an hrSeries + ctx were supplied
    hrZones,                    // populated when an hrSeries + ctx + zones were supplied
    polyline: null,
    kmSplits: kmSplits.length ? kmSplits : null,
    averageWatts: null,
    maxWatts: null,
    normalizedPowerW: null,
    powerCurve: null,
    deviceWatts: null,
    repData: null,
  };
}

/**
 * Commit a confirmed screenshot activity into the app: match it, fold in any PB,
 * refresh fitness, and heal iTrimp. Mirrors the single-file import tail so a
 * screenshot run drives the plan like any other source.
 *
 * When the parsed activity carries an `hrSeries` (from the AI `hr_chart` mode),
 * we hand the row builder an enrichment context built from the user's resting
 * HR / max HR / zones / sex so the row arrives with a real iTRIMP and HR-zone
 * breakdown rather than the coarse heal-pass estimate.
 */
export function commitScreenshotActivity(p: ParsedScreenshotActivity, startTimeISO: string): boolean {
  const s = getMutableState();
  const ctx: ScreenshotEnrichmentContext | undefined = p.hrSeries && p.hrSeries.length >= 2
    ? {
        restingHR: computeRollingRestingHR(s.physiologyHistory, s.restingHR) ?? null,
        userMaxHR: s.maxHR ?? null,
        sex: resolveTrimpSex(s),
        zones: calculateZones({
          maxHR: s.maxHR ?? undefined,
          restingHR: s.restingHR ?? undefined,
        }),
      }
    : undefined;
  const row = screenshotActivityToRow(p, startTimeISO, ctx);
  const changed = matchAndAutoComplete([row]);
  if (!changed) return false;
  applyPBsFromRows([row]);
  healMissingITrimp();
  try { refreshBlendedFitness(getMutableState()); } catch (e) { console.warn('[Screenshot] refreshBlendedFitness failed:', e); }
  saveState();
  render();
  return true;
}
