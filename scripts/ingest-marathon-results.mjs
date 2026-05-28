#!/usr/bin/env node
/**
 * Ingest a marathon / half-marathon finisher CSV into baked percentile tables
 * for `src/data/marathon-population-distributions.ts`.
 *
 * Mirrors `scripts/ingest-hyrox-results.mjs`. One invocation = one venue.
 *
 * Run:
 *   node scripts/ingest-marathon-results.mjs <csv-path> <venue-id> [options]
 *
 * Options:
 *   --time-col=NAME       column with finish time (default: "OfficialTime" or
 *                         autodetect among common names)
 *   --time-format=AUTO    "hms" (h:mm:ss), "seconds", or "minutes". Default
 *                         tries to detect from the first non-empty value.
 *   --filter-col=NAME     optional column to filter on
 *   --filter-val=VALUE    value to match (e.g. --filter-col=Event --filter-val=Marathon)
 *   --min-sec=N           drop finishes below N seconds (default: 8400 ≈ 2:20 marathon)
 *   --max-sec=N           drop finishes above N seconds (default: 30600 ≈ 8:30 marathon)
 *
 * Output: prints the const block + provenance line for the venue. Paste into
 * `src/data/marathon-population-distributions.ts` and update the file's
 * POPULATION_DATA_AVAILABLE flag + LAST_REFRESH_DATE.
 *
 * Recommended sources (Kaggle):
 *   - runningwithrock/nyc-marathon-results-all-years    → venue-id "nyc"
 *   - runningwithrock/chicago-marathon-results          → venue-id "chicago"
 *   - rojour/boston-results                             → venue-id "boston"
 *   - kevinegan/london-marathon-results                 → venue-id "london"
 *   - aiaiaidavid/berlin-marathons-data                 → venue-id "berlin"
 *   - runningwithrock/boston-marathon-qualifiers-dataset
 *       Filter via --filter-col=Race --filter-val=<venue label>
 */
import fs from 'node:fs';

// ── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.join('=') || true];
    }),
);

if (positional.length < 2) {
  console.error('Usage: node scripts/ingest-marathon-results.mjs <csv-path> <venue-id> [options]');
  console.error('Run with --help for options.');
  process.exit(1);
}

const [CSV_PATH, VENUE_ID] = positional;
const MIN_SEC = Number(flags['min-sec'] ?? 8400);    // 2:20:00
const MAX_SEC = Number(flags['max-sec'] ?? 30600);   // 8:30:00
const TIME_COL_OVERRIDE = flags['time-col'] || null;
const TIME_FORMAT = flags['time-format'] || 'auto';
const FILTER_COL = flags['filter-col'] || null;
const FILTER_VAL = flags['filter-val'] || null;

// ── Helpers ──────────────────────────────────────────────────────────────────

const COMMON_TIME_COLS = [
  'OfficialTime', 'Official Time', 'official_time',
  'Net Time', 'NetTime', 'net_time',
  'Time', 'time', 'finish_time', 'FinishTime',
  'total_time', 'TotalTime',
];

const BREAKS = [1, 5, 10, 25, 50, 75, 90, 95, 99];

function timeStringToSec(s) {
  if (s == null) return NaN;
  const trimmed = String(s).trim();
  if (!trimmed || trimmed === 'DNF' || trimmed === 'DNS' || trimmed === '-') return NaN;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function detectTimeFormat(sampleValue) {
  const s = String(sampleValue).trim();
  if (/:/.test(s)) return 'hms';
  const n = Number(s);
  if (!isFinite(n)) return 'hms';
  if (n > 1000) return 'seconds';      // > 1000 raw → almost certainly seconds
  if (n > 100)  return 'minutes';      // 100..1000 → minutes is more plausible
  return 'hms';
}

function valueToSec(s, format) {
  if (format === 'hms') return timeStringToSec(s);
  if (format === 'seconds') return Number(s);
  if (format === 'minutes') return Number(s) * 60;
  return NaN;
}

function percentileAt(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

// Naive CSV row split — assumes no embedded commas inside quoted fields, which
// is the case for the Kaggle datasets listed in the docstring. Upgrade to a
// proper parser if a source CSV breaks this.
function splitCsvLine(line) {
  return line.split(',').map(s => s.replace(/^"|"$/g, ''));
}

// ── Read + parse ─────────────────────────────────────────────────────────────

const raw = fs.readFileSync(CSV_PATH, 'utf-8');
const lines = raw.split('\n').filter(l => l.trim());
if (lines.length < 2) {
  console.error(`CSV at ${CSV_PATH} has no data rows.`);
  process.exit(1);
}

const header = splitCsvLine(lines[0]);

const timeColName = TIME_COL_OVERRIDE
  ?? COMMON_TIME_COLS.find(n => header.includes(n))
  ?? null;
if (!timeColName) {
  console.error(`Could not autodetect a finish-time column. Found columns:\n  ${header.join(', ')}`);
  console.error(`Pass --time-col=<name> explicitly.`);
  process.exit(1);
}

const timeColIdx = header.indexOf(timeColName);
const filterColIdx = FILTER_COL ? header.indexOf(FILTER_COL) : -1;

if (FILTER_COL && filterColIdx < 0) {
  console.error(`--filter-col=${FILTER_COL} not found in CSV header.`);
  process.exit(1);
}

// Determine time format from first non-empty value.
let format = TIME_FORMAT;
if (format === 'auto') {
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const v = cells[timeColIdx];
    if (v && String(v).trim()) {
      format = detectTimeFormat(v);
      break;
    }
  }
}

const times = [];
let dropped = 0;
let filteredOut = 0;
for (let i = 1; i < lines.length; i++) {
  const cells = splitCsvLine(lines[i]);
  if (filterColIdx >= 0 && cells[filterColIdx] !== FILTER_VAL) {
    filteredOut++;
    continue;
  }
  const sec = valueToSec(cells[timeColIdx], format);
  if (!isFinite(sec) || sec < MIN_SEC || sec > MAX_SEC) {
    dropped++;
    continue;
  }
  times.push(sec);
}

if (times.length === 0) {
  console.error(`No valid finish times after filtering. Dropped ${dropped}, filtered out ${filteredOut}.`);
  process.exit(1);
}

times.sort((a, b) => a - b);

// ── Build percentile table ──────────────────────────────────────────────────

const table = BREAKS.map(p => [percentileAt(times, p), p]);

// ── Output ──────────────────────────────────────────────────────────────────

const venueKey = /-/.test(VENUE_ID) ? `'${VENUE_ID}'` : VENUE_ID;

console.log(`// ── Ingested ${new Date().toISOString().slice(0, 10)} from ${CSV_PATH} ───`);
console.log(`// Rows used: ${times.length.toLocaleString()}  (dropped: ${dropped}, filtered: ${filteredOut})`);
console.log(`// Time column: "${timeColName}" parsed as ${format}.`);
console.log('');
console.log(`// Paste into VENUE_PERCENTILE_TABLES in marathon-population-distributions.ts:`);
console.log(`  ${venueKey}: [${table.map(([t, p]) => `[${t}, ${p}]`).join(', ')}],`);
console.log('');
console.log(`// Update VENUE_DATA_PROVENANCE entry for "${VENUE_ID}":`);
console.log(`  ${venueKey}: { source: 'kaggle', n: ${times.length}, years: '<fill-in>', attribution: '<fill-in>', hasSplits: false },`);
console.log('');
console.log(`// isPopulationDataAvailable() in the data file auto-derives from table contents,`);
console.log(`// so no manual flag flip is needed. Bump LAST_REFRESH_DATE if appropriate.`);
