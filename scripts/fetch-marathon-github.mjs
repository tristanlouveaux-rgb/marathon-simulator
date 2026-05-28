#!/usr/bin/env node
/**
 * Fetch + ingest marathon finisher data directly from the public
 * AndrewMillerOnline/marathon-results GitHub repo (MIT-licensed).
 *
 * Repo structure: <Venue>/results-<YYYY>.csv, columns:
 *   place_overall, first_name, last_name, nationality, club, time_full,
 *   gender, split_5k, split_10k, ..., split_40k, time_half, Race, year
 *
 * Covers: Berlin, Boston, Chicago, London, New York City, Honolulu, Portland.
 * Years vary by venue (typical: 1999-2019).
 *
 * Run:
 *   node scripts/fetch-marathon-github.mjs              # all venues, last 5 years
 *   node scripts/fetch-marathon-github.mjs --years=10   # last 10 years per venue
 *   node scripts/fetch-marathon-github.mjs --venue=Berlin --years=20
 *
 * Output: paste-ready const blocks for `VENUE_PERCENTILE_TABLES` +
 * matching `VENUE_DATA_PROVENANCE` entries.
 */

import { argv } from 'node:process';

const flags = Object.fromEntries(
  argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.replace(/^--/, '').split('=');
      return [k, v.join('=') || true];
    }),
);

const REPO = 'AndrewMillerOnline/marathon-results';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/main`;
const API_BASE = `https://api.github.com/repos/${REPO}/contents`;

/** Map GitHub folder name → catalogue venue id from src/data/marathons.ts. */
const VENUE_MAP = {
  'Berlin': 'berlin',
  'Boston': 'boston',
  'Chicago': 'chicago',
  'London': 'london',
  'New York City': 'nyc',
  // Honolulu + Portland are in the repo but not in our catalogue — they pool
  // into the marathon distance-aggregate fallback only.
  'Honolulu': null,
  'Portland': null,
};

const YEARS_BACK = Number(flags.years ?? 5);
const VENUE_FILTER = flags.venue || null;
const MIN_SEC = 8400;     // 2:20:00 — faster than the world record, exclude
const MAX_SEC = 30600;    // 8:30:00 — beyond typical cutoff windows

const BREAKS = [1, 5, 10, 25, 50, 75, 90, 95, 99];

function timeToSec(s) {
  if (!s) return NaN;
  const trimmed = String(s).trim();
  if (!trimmed || trimmed === '00:00:00') return NaN;
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return NaN;
}

function percentileAt(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'mosaic-ingest' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'mosaic-ingest' } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.text();
}

/** Lists all results files for a venue. Filename patterns vary:
 *  - "results-YYYY.csv" (Berlin, Chicago, NYC, Honolulu, Portland)
 *  - "results-YYYY-YYYY.csv" (Boston, London — multi-year combined files)
 *  Returns an array of { filename, yearMin, yearMax } sorted newest-first. */
async function listVenueFiles(venueFolder) {
  const items = await fetchJSON(`${API_BASE}/${encodeURIComponent(venueFolder)}`);
  const files = [];
  for (const x of items) {
    if (x.type !== 'file') continue;
    const singleYear = x.name.match(/^results-(\d{4})\.csv$/);
    if (singleYear) {
      const y = Number(singleYear[1]);
      files.push({ filename: x.name, yearMin: y, yearMax: y, size: x.size });
      continue;
    }
    const rangeYear = x.name.match(/^results-(\d{4})-(\d{4})\.csv$/);
    if (rangeYear) {
      files.push({
        filename: x.name,
        yearMin: Number(rangeYear[1]),
        yearMax: Number(rangeYear[2]),
        size: x.size,
      });
    }
  }
  return files.sort((a, b) => b.yearMax - a.yearMax);
}

/** Proper CSV line parser — handles quoted fields with embedded commas.
 *  Chicago has URL-encoded brackets and quoted names like "Aaflaq, Peter (USA)";
 *  NYC has quoted numerics like "10,201". Naive split breaks on both. */
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  cells.push(cur);
  return cells;
}

function parseCsv(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { times: [], dropped: 0 };
  const header = splitCsvLine(lines[0]);
  // Modern files use 'time_full'; Boston's historical 1897-2000 file uses 'Time'.
  let timeIdx = header.indexOf('time_full');
  if (timeIdx < 0) timeIdx = header.indexOf('Time');
  if (timeIdx < 0) return { times: [], dropped: lines.length - 1 };

  const times = [];
  let dropped = 0;
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const sec = timeToSec(cells[timeIdx]);
    if (!isFinite(sec) || sec < MIN_SEC || sec > MAX_SEC) {
      dropped++;
      continue;
    }
    times.push(sec);
  }
  return { times, dropped };
}

async function ingestVenue(venueFolder, venueId) {
  process.stderr.write(`\n[${venueFolder}] listing files... `);
  const allFiles = await listVenueFiles(venueFolder);
  if (allFiles.length === 0) {
    process.stderr.write('no results files found\n');
    return null;
  }
  // Pick newest files until cumulative year-coverage hits YEARS_BACK.
  // Multi-year-range files count their full span.
  const filesToFetch = [];
  let yearsCovered = 0;
  for (const f of allFiles) {
    if (yearsCovered >= YEARS_BACK) break;
    filesToFetch.push(f);
    yearsCovered += (f.yearMax - f.yearMin + 1);
  }
  process.stderr.write(`fetching ${filesToFetch.length} file(s) covering ~${yearsCovered} years\n`);

  const allTimes = [];
  let totalDropped = 0;
  let yearMin = Infinity, yearMax = -Infinity;
  for (const f of filesToFetch) {
    const url = `${RAW_BASE}/${encodeURIComponent(venueFolder)}/${encodeURIComponent(f.filename)}`;
    try {
      const text = await fetchText(url);
      const { times, dropped } = parseCsv(text);
      // Push items individually to avoid spread-stack overflow on big arrays.
      for (let i = 0; i < times.length; i++) allTimes.push(times[i]);
      totalDropped += dropped;
      yearMin = Math.min(yearMin, f.yearMin);
      yearMax = Math.max(yearMax, f.yearMax);
      process.stderr.write(`  ${f.filename}: ${times.length.toLocaleString()} valid, ${dropped} dropped\n`);
    } catch (e) {
      process.stderr.write(`  ${f.filename}: SKIP (${e.message})\n`);
    }
  }

  if (allTimes.length === 0) return null;
  allTimes.sort((a, b) => a - b);
  const table = BREAKS.map(p => [percentileAt(allTimes, p), p]);
  return {
    venueId,
    venueFolder,
    n: allTimes.length,
    dropped: totalDropped,
    yearMin,
    yearMax,
    table,
    rawTimes: allTimes,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

const venuesToProcess = Object.entries(VENUE_MAP)
  .filter(([folder, id]) => id !== null)
  .filter(([folder]) => !VENUE_FILTER || folder === VENUE_FILTER);

const results = [];
const aggregateTimes = [];

for (const [folder, id] of venuesToProcess) {
  const r = await ingestVenue(folder, id);
  if (r) results.push(r);
}

// Build distance aggregate from pooled raw times across all in-catalogue venues.
// Push individually to avoid spread-stack overflow on big arrays.
for (const r of results) {
  for (let i = 0; i < r.rawTimes.length; i++) aggregateTimes.push(r.rawTimes[i]);
}

aggregateTimes.sort((a, b) => a - b);
const aggregateTable = aggregateTimes.length > 0
  ? BREAKS.map(p => [percentileAt(aggregateTimes, p), p])
  : null;

// ── Output ────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);

console.log('// ═══════════════════════════════════════════════════════════════');
console.log(`// Generated ${today} by scripts/fetch-marathon-github.mjs`);
console.log(`// Source: AndrewMillerOnline/marathon-results (MIT-licensed)`);
console.log(`// Years per venue: ${YEARS_BACK} most recent available`);
console.log('// ═══════════════════════════════════════════════════════════════\n');

console.log('// ── Per-venue tables (paste into VENUE_PERCENTILE_TABLES) ────────');
for (const r of results) {
  console.log(`  ${r.venueId}: [${r.table.map(([t, p]) => `[${t}, ${p}]`).join(', ')}],`);
}

console.log('\n// ── Per-venue provenance (paste into VENUE_DATA_PROVENANCE) ──────');
for (const r of results) {
  const attr = `Source: AndrewMillerOnline/marathon-results (GitHub, MIT).`;
  const years = r.yearMin === r.yearMax ? String(r.yearMin) : `${r.yearMin}-${r.yearMax}`;
  console.log(`  ${r.venueId}: { source: 'official-scrape', n: ${r.n}, years: '${years}', attribution: '${attr}', hasSplits: true },`);
}

if (aggregateTable) {
  console.log('\n// ── Marathon distance aggregate (paste into DISTANCE_AGGREGATE_PERCENTILE_TABLES.marathon) ───');
  console.log(`  marathon: [${aggregateTable.map(([t, p]) => `[${t}, ${p}]`).join(', ')}],`);
  console.log(`// Pooled from ${results.length} venues, ${aggregateTimes.length.toLocaleString()} raw finishes.`);
}

console.log('\n// Bump LAST_REFRESH_DATE to ' + today);
console.log('// Total venues ingested: ' + results.length);
console.log('// Total finishes used:   ' + results.reduce((s, r) => s + r.n, 0).toLocaleString());
