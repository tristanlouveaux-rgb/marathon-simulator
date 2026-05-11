/**
 * Calibration dataset loader.
 *
 * Loads two public Kaggle datasets of triathlon race finishes and normalises
 * them into a single shape for downstream calibration scripts.
 *
 *   - 70.3:  Half_Ironman_df6.csv (single CSV, ~840k rows, times in seconds)
 *           Schema: Gender,AgeGroup,AgeBand,Country,CountryISO2,EventYear,
 *                   EventLocation,SwimTime,T1Time,BikeTime,T2Time,RunTime,FinishTime
 *
 *   - IM:    races.csv + results.csv + series.csv (relational, ~1.09M rows,
 *           times as HH:MM:SS / MM:SS strings).
 *
 * **Streaming.** results.csv is 240MB and a naive in-memory parse OOMs Node's
 * default 1.5GB heap. We stream line-by-line with readline + readFileSync of
 * the small lookup CSVs (races, series), and build the normalised FinishRecord[]
 * directly without an intermediate string[][] for the big files.
 *
 * **Not for runtime.** Production runtime consumes the precomputed JSON of
 * empirical course factors emitted by the calibration script — never these
 * CSVs directly.
 *
 * Data location: `validation/data/` (gitignored — regenerate from Kaggle).
 *   - 70.3:    https://www.kaggle.com/datasets/aiaiaidavid/ironman-703-race-data-between-2004-and-2020
 *   - IM 140.6: https://www.kaggle.com/datasets/miguswong/ironman-140-6-results-dataset-2002-2024
 */

import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ───────────────────────────────────────────────────────────────────────────
// Normalised record shape (same for both 70.3 and IM)
// ───────────────────────────────────────────────────────────────────────────

export type Distance = '70.3' | 'ironman';

export interface FinishRecord {
  distance: Distance;
  /** Race location key — e.g., "IRONMAN 70.3 Lanzarote" or "Ironman Texas". */
  eventLocation: string;
  eventYear: number;
  gender: 'M' | 'F';
  /** Daniels-style age band from the data — preserved verbatim ("40-44"). */
  ageGroup: string;
  /** Athlete identifier when available (IM only); otherwise undefined. Used
   *  for athlete fixed-effects in course-factor calibration. */
  athleteId?: string;
  /** Country (some rows have noise like "Atletas Es" — caller should treat
   *  this as a soft control variable, not authoritative). */
  country: string;
  swimSec: number;
  bikeSec: number;
  runSec: number;
  /** Total finish time in seconds (incl. T1 + T2). */
  finishSec: number;
  /** T1 seconds. Populated for 70.3 only (separable column in the source CSV). */
  t1Sec?: number;
  /** T2 seconds. Populated for 70.3 only. */
  t2Sec?: number;
  /** T1 + T2 combined. Populated for both distances:
   *   - 70.3:    T1 + T2 from the CSV columns.
   *   - ironman: derived as finishSec − swim − bike − run (no separate columns). */
  transitionSec?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Minimal RFC4180 CSV line parser (handles quoted fields with embedded commas)
// ───────────────────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === ',') { fields.push(current); current = ''; }
      else if (ch === '"' && current === '') { inQuotes = true; }
      else { current += ch; }
    }
  }
  fields.push(current);
  return fields;
}

// ───────────────────────────────────────────────────────────────────────────
// Time parsing
// ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a time field. Accepts:
 *   - integer seconds: "16514"
 *   - HH:MM:SS:        "8:03:13"
 *   - MM:SS:           "48:19"
 *   - empty / DNF:     ""  → NaN (caller filters)
 */
export function parseTimeToSec(s: string | undefined): number {
  if (s == null || s.length === 0 || s === '---') return NaN;
  const trimmed = s.trim();
  if (trimmed.length === 0) return NaN;
  if (/^\d+$/.test(trimmed)) return Number(trimmed); // integer seconds
  const parts = trimmed.split(':').map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p))) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];           // MM:SS
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
  return NaN;
}

// ───────────────────────────────────────────────────────────────────────────
// Streaming CSV reader: invokes a callback per row, yielding control between
// lines so memory stays bounded. Header is read first and passed to caller.
// ───────────────────────────────────────────────────────────────────────────

async function streamCsv(
  path: string,
  onHeader: (header: string[]) => void,
  onRow: (fields: string[]) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let headerSeen = false;
  for await (const line of rl) {
    if (line.length === 0) continue;
    if (!headerSeen) {
      onHeader(parseCsvLine(line));
      headerSeen = true;
      continue;
    }
    onRow(parseCsvLine(line));
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Loaders
// ───────────────────────────────────────────────────────────────────────────

const DATA_DIR = resolve(process.cwd(), 'validation/data');

export interface LoaderFilter {
  /** Drop pros (Division "MPRO" / "FPRO"). Default true. */
  excludePros?: boolean;
  /** Only include finishers (status === "Finisher"). Default true. */
  finishersOnly?: boolean;
  /** Optional minimum/maximum finish time in seconds (sanity bounds). */
  minFinishSec?: number;
  maxFinishSec?: number;
}

const DEFAULTS: Required<LoaderFilter> = {
  excludePros: true,
  finishersOnly: true,
  // 70.3: ≥ 3:00, ≤ 9:00 typical bound
  // IM:   ≥ 7:00, ≤ 17:00 cutoff
  minFinishSec: 3 * 3600,
  maxFinishSec: 18 * 3600,
};

export async function load703(filter: LoaderFilter = {}): Promise<FinishRecord[]> {
  const f = { ...DEFAULTS, ...filter };
  const path = resolve(DATA_DIR, 'Half_Ironman_df6.csv');
  const out: FinishRecord[] = [];

  let iGender = -1, iAge = -1, iCountry = -1, iYear = -1, iLoc = -1;
  let iSwim = -1, iBike = -1, iRun = -1, iFin = -1;
  let iT1 = -1, iT2 = -1;

  await streamCsv(
    path,
    (header) => {
      iGender = header.indexOf('Gender');
      iAge = header.indexOf('AgeGroup');
      iCountry = header.indexOf('Country');
      iYear = header.indexOf('EventYear');
      iLoc = header.indexOf('EventLocation');
      iSwim = header.indexOf('SwimTime');
      iBike = header.indexOf('BikeTime');
      iRun = header.indexOf('RunTime');
      iFin = header.indexOf('FinishTime');
      iT1 = header.indexOf('Transition1Time');
      iT2 = header.indexOf('Transition2Time');
      const required = [iGender, iAge, iCountry, iYear, iLoc, iSwim, iBike, iRun, iFin];
      if (required.some((i) => i < 0)) {
        throw new Error(`70.3 CSV missing one of required columns. Got: ${header.join(', ')}`);
      }
    },
    (r) => {
      const gender = r[iGender] === 'M' ? 'M' : r[iGender] === 'F' ? 'F' : null;
      if (gender == null) return;
      const swim = parseTimeToSec(r[iSwim]);
      const bike = parseTimeToSec(r[iBike]);
      const run = parseTimeToSec(r[iRun]);
      const fin = parseTimeToSec(r[iFin]);
      if (
        !Number.isFinite(swim) || swim <= 0 ||
        !Number.isFinite(bike) || bike <= 0 ||
        !Number.isFinite(run) || run <= 0 ||
        !Number.isFinite(fin) || fin <= 0
      ) return;
      if (fin < f.minFinishSec || fin > f.maxFinishSec) return;

      // Transitions: 30-min sanity bound on each leg drops obvious data errors.
      let t1: number | undefined = iT1 >= 0 ? parseTimeToSec(r[iT1]) : undefined;
      let t2: number | undefined = iT2 >= 0 ? parseTimeToSec(r[iT2]) : undefined;
      if (!Number.isFinite(t1!) || t1! <= 0 || t1! > 30 * 60) t1 = undefined;
      if (!Number.isFinite(t2!) || t2! <= 0 || t2! > 30 * 60) t2 = undefined;
      const transitionSec =
        t1 !== undefined && t2 !== undefined ? t1 + t2 : undefined;

      out.push({
        distance: '70.3',
        eventLocation: r[iLoc],
        eventYear: Number(r[iYear]),
        gender,
        ageGroup: r[iAge],
        country: r[iCountry],
        swimSec: swim,
        bikeSec: bike,
        runSec: run,
        finishSec: fin,
        t1Sec: t1,
        t2Sec: t2,
        transitionSec,
      });
    },
  );

  return out;
}

export async function loadIM(filter: LoaderFilter = {}): Promise<FinishRecord[]> {
  const f = { ...DEFAULTS, ...filter };

  // races.csv + series.csv are tiny — load synchronously with readFileSync.
  const racesText = readFileSync(resolve(DATA_DIR, 'races.csv'), 'utf8');
  const racesLines = racesText.split(/\r?\n/).filter((l) => l.length > 0);
  const racesHeader = parseCsvLine(racesLines[0]);
  const ridIdx = racesHeader.indexOf('id');
  const ryearIdx = racesHeader.indexOf('year');
  const rseriesIdx = racesHeader.indexOf('seriesID');
  const raceMeta = new Map<string, { year: number; seriesId: string }>();
  for (let i = 1; i < racesLines.length; i++) {
    const row = parseCsvLine(racesLines[i]);
    raceMeta.set(row[ridIdx], { year: Number(row[ryearIdx]), seriesId: row[rseriesIdx] });
  }

  const seriesText = readFileSync(resolve(DATA_DIR, 'series.csv'), 'utf8');
  const seriesLines = seriesText.split(/\r?\n/).filter((l) => l.length > 0);
  const seriesHeader = parseCsvLine(seriesLines[0]);
  const sidIdx = seriesHeader.indexOf('id');
  const slocIdx = seriesHeader.indexOf('location');
  const seriesLoc = new Map<string, string>();
  for (let i = 1; i < seriesLines.length; i++) {
    const row = parseCsvLine(seriesLines[i]);
    seriesLoc.set(row[sidIdx], row[slocIdx]);
  }

  // results.csv is the big one — stream it.
  const out: FinishRecord[] = [];
  let iCountry = -1, iGender = -1, iDiv = -1, iSwim = -1, iBike = -1, iRun = -1;
  let iOverall = -1, iStatus = -1, iRaceId = -1, iAthleteId = -1;

  await streamCsv(
    resolve(DATA_DIR, 'results.csv'),
    (header) => {
      iCountry = header.indexOf('Country');
      iGender = header.indexOf('Gender');
      iDiv = header.indexOf('Division');
      iSwim = header.indexOf('swimTime');
      iBike = header.indexOf('bikeTime');
      iRun = header.indexOf('runTime');
      iOverall = header.indexOf('overallTime');
      iStatus = header.indexOf('finishStatus');
      iRaceId = header.indexOf('raceID');
      iAthleteId = header.indexOf('athleteID');
    },
    (r) => {
      if (f.finishersOnly && r[iStatus] !== 'Finisher') return;
      const division = r[iDiv] ?? '';
      if (f.excludePros && (division === 'MPRO' || division === 'FPRO')) return;
      const gender = r[iGender] === 'Male' ? 'M' : r[iGender] === 'Female' ? 'F' : null;
      if (gender == null) return;

      const swim = parseTimeToSec(r[iSwim]);
      const bike = parseTimeToSec(r[iBike]);
      const run = parseTimeToSec(r[iRun]);
      const fin = parseTimeToSec(r[iOverall]);
      if (
        !Number.isFinite(swim) || swim <= 0 ||
        !Number.isFinite(bike) || bike <= 0 ||
        !Number.isFinite(run) || run <= 0 ||
        !Number.isFinite(fin) || fin <= 0
      ) return;
      if (fin < f.minFinishSec || fin > f.maxFinishSec) return;

      const meta = raceMeta.get(r[iRaceId]);
      if (!meta) return;
      const location = seriesLoc.get(meta.seriesId);
      if (!location) return;

      // IM Division is e.g. "M40-44" / "F35-39" — strip leading gender letter.
      const ageGroup = /^[MF]\d/.test(division) ? division.slice(1) : division;

      // Combined transition derived as overall − legs. Drop rows where this
      // is non-positive (data error) or > 60 min total (likely a missing leg
      // time inflating the residual). 60 min is generous for IM where slow
      // age-groupers spend ~10–15 min in T1 and again in T2.
      const transitionResidual = fin - swim - bike - run;
      const transitionSec =
        transitionResidual > 0 && transitionResidual <= 60 * 60
          ? transitionResidual
          : undefined;

      out.push({
        distance: 'ironman',
        eventLocation: location,
        eventYear: meta.year,
        gender,
        ageGroup,
        athleteId: r[iAthleteId],
        country: r[iCountry],
        swimSec: swim,
        bikeSec: bike,
        runSec: run,
        finishSec: fin,
        transitionSec,
      });
    },
  );

  return out;
}

/** Load both datasets in one call, concatenated. */
export async function loadAll(filter: LoaderFilter = {}): Promise<FinishRecord[]> {
  const [r703, rIM] = await Promise.all([load703(filter), loadIM(filter)]);
  return [...r703, ...rIM];
}
