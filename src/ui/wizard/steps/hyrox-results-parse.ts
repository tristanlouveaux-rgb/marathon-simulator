import { STATION_MIN_SEC, HYROX_RUN_PACE_MIN_SEC_KM } from '@/constants/hyrox-benchmarks';
import type { HyroxStation } from '@/types/triathlon';

/**
 * Pure parser for hyrox.com results text. Lives in its own module (no DOM /
 * window imports) so it stays unit-testable and reusable from any surface.
 *
 * Designed to be forgiving of an imperfect mobile copy: it scans free-form
 * text for station names and grabs the nearest time, ignoring navigation
 * chrome, blank lines, and unselected stations. A rough partial selection
 * yields whatever stations it can find rather than failing outright.
 */

/** Parse a mm:ss or h:mm:ss string to seconds. Returns NaN on failure. */
function parseTime(raw: string): number {
  const parts = raw.trim().split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

/**
 * Parses station split times from free-form text copied from hyrox.com results.
 * Strategy: find each station name, then grab the first mm:ss within 200 chars after it.
 * Handles variations: "SkiErg" / "Ski Erg" / "Ski-Erg", "Rowing" / "Row Erg", etc.
 */
/**
 * How a station time was derived, so the UI can flag the lower-confidence ones:
 *  - 'structured': from the "Station In / Station Out" timestamp pair. The
 *    duration is a subtraction of two anchored timestamps, so it's reliable.
 *  - 'fallback': from the looser "station name → nearest time" scan. On a messy
 *    or whitespace-collapsed mobile copy this can grab a cumulative/diff column
 *    instead of the split, so it warrants a human check.
 */
export type StationSource = 'structured' | 'fallback';

export function parseHyroxResultsText(text: string): {
  stations: Partial<Record<HyroxStation, number>>;
  /** Per-station provenance, keyed identically to `stations`. */
  stationSource: Partial<Record<HyroxStation, StationSource>>;
  runPaceSecKm?: number;
  /** "Total time" parsed from the export, in seconds. Used for sanity-check display. */
  totalRaceSec?: number;
  /** Run 1 to run 8 ("Running 3  04:51"), seconds; null where a leg was not
   *  in the text. Absent when no leg was found. */
  runLegsSec?: Array<number | null>;
  /** The 8 runs together: the sum of the legs when all 8 were found, else a
   *  "Run Total" line. */
  runTotalSec?: number;
  /** Total Roxzone time ("Roxzone Time", "Roxzone Total", "Total Roxzone",
   *  or a single bare "Roxzone" line). Several bare "Roxzone" lines are
   *  per-transition times and are not summed. */
  roxzoneSec?: number;
} {
  const STATION_PATTERNS: Array<{ pattern: RegExp; station: HyroxStation }> = [
    { pattern: /ski[\s-]*erg/i,              station: 'ski_erg' },
    { pattern: /sled\s+push/i,               station: 'sled_push' },
    { pattern: /sled\s+pull/i,               station: 'sled_pull' },
    { pattern: /burpee/i,                    station: 'burpee_broad_jumps' },
    { pattern: /\brow(?:ing|\s*erg)?\b/i,     station: 'row_erg' },
    { pattern: /farmers?[\s']*\s*carry/i,    station: 'farmer_carry' },
    { pattern: /sandbag/i,                   station: 'sandbag_lunges' },
    { pattern: /wall[\s-]*ball/i,            station: 'wall_balls' },
  ];

  /**
   * Extract time in seconds from a short string window.
   * Handles both h:mm:ss (e.g. 00:02:56 from hyrox.com) and mm:ss.
   * h:mm:ss is tried first so "00:02:56" yields 176s not 2s.
   */
  function extractTimeSec(window: string): number | null {
    // h:mm:ss (hyrox.com format: 00:mm:ss)
    const longM = /\b(\d+):(\d{2}):(\d{2})\b/.exec(window);
    if (longM) {
      const h = Number(longM[1]), m = Number(longM[2]), s = Number(longM[3]);
      if (s < 60 && m < 60) return h * 3600 + m * 60 + s;
    }
    // mm:ss fallback
    const shortM = /\b(\d{1,2}):(\d{2})\b/.exec(window);
    if (shortM) {
      const m = Number(shortM[1]), s = Number(shortM[2]);
      if (s < 60 && m <= 30) return m * 60 + s;
    }
    return null;
  }

  /** The time after a label: on the label's own line first (so a later
   *  line's h:mm:ss never wins over this line's mm:ss), else within
   *  `windowLen` characters (a copy that breaks the time onto the next line). */
  function timeNear(start: number, windowLen: number): number | null {
    const window = text.slice(start, start + windowLen);
    const nl = window.indexOf('\n');
    const sameLine = nl >= 0 ? window.slice(0, nl) : window;
    return extractTimeSec(sameLine) ?? extractTimeSec(window);
  }

  const stations: Partial<Record<HyroxStation, number>> = {};
  const stationSource: Partial<Record<HyroxStation, StationSource>> = {};

  // ── Strategy 1: "Station In / Station Out" timestamp-pair format ─────────
  // Hyrox timing-system export. Each station has two lines, each with multiple
  // columns (Time of Day, cumulative race time, diff):
  //   "SkiErg In   10:43:16  03:08  0:14"
  //   "SkiErg Out  10:47:03  06:56  03:48"
  // Duration = (Out time of day) − (In time of day). The first time on each
  // line is used; cumulative and diff columns are ignored. Any consistent
  // HH:MM:SS or MM:SS scheme works because subtraction cancels the offset.
  //
  // Wall Balls has no "Out" line in the export (it's the last station); we
  // fall back to the "Total time" timestamp for its duration.
  //
  // Labels can be multi-word ("Burpee Broad Jump", "Sandbag Lunges",
  // "Wall Balls"), so we collect events independently rather than pairing
  // them with a single regex.
  const stationEvents = new Map<HyroxStation, { in?: number; out?: number }>();
  const EVENT_RE = /^[ \t]*(.+?)\s+(In|Out)\b[ \t]+(\d{1,2}:\d{2}(?::\d{2})?)/gim;
  let evMatch: RegExpExecArray | null;
  while ((evMatch = EVENT_RE.exec(text)) !== null) {
    const label = evMatch[1].trim();
    const kind = evMatch[2].toLowerCase() as 'in' | 'out';
    const sec = parseTime(evMatch[3]);
    if (isNaN(sec)) continue;
    const matched = STATION_PATTERNS.find(({ pattern }) => pattern.test(label));
    if (!matched) continue; // skips Roxzone In/Out and any other non-station label
    const ev = stationEvents.get(matched.station) ?? {};
    if (kind === 'in' && ev.in == null) ev.in = sec;
    else if (kind === 'out' && ev.out == null) ev.out = sec;
    stationEvents.set(matched.station, ev);
  }

  // The "Total time" line carries up to three distinct numbers in the
  // timing-system export:
  //   "Total time   11:40:50   1:00:43   03:48"
  //                 time-of-day cumulative diff
  // We need BOTH:
  //   - cumulative race duration → for `totalRaceSec` display (1:00:43)
  //   - time-of-day at finish    → to compute Wall Balls duration when the
  //                                 export omits a "Wall Balls Out" line
  //                                 (we subtract Wall-Balls-In time-of-day
  //                                 from finish time-of-day).
  let totalSec: number | null = null;
  let totalEndTimeOfDay: number | null = null;
  const totalLineMatch = /total\s*time([^\n]+)/i.exec(text);
  if (totalLineMatch) {
    const candidates: number[] = [];
    const timeRe = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;
    let tm: RegExpExecArray | null;
    while ((tm = timeRe.exec(totalLineMatch[1])) !== null) {
      const a = Number(tm[1]), b = Number(tm[2]), c = tm[3] != null ? Number(tm[3]) : null;
      const sec = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
      if (!isNaN(sec) && sec > 0) candidates.push(sec);
    }
    // Cumulative race duration: realistic Hyrox window (10 min – 4 h).
    const inWindow = candidates.filter(s => s >= 600 && s <= 14400);
    if (inWindow.length > 0) totalSec = Math.min(...inWindow);
    else if (candidates.length > 0) totalSec = candidates[0];
    // Time-of-day timestamp: the largest value, only kept if it lands above
    // any station "In" time-of-day we collected (i.e. it's plausibly later
    // in the day on the same race clock).
    if (candidates.length > 0) {
      const maxIn = Math.max(0, ...Array.from(stationEvents.values()).map(e => e.in ?? 0));
      const todCandidates = candidates.filter(s => s > maxIn);
      if (todCandidates.length > 0) totalEndTimeOfDay = Math.max(...todCandidates);
    }
  }

  // Hard sanity ceiling: no Hyrox station takes more than 25 min in any
  // realistic finish. Anything above is almost certainly a time-of-day
  // timestamp leaking through (root cause of the 11:37:02 = 41822s bug
  // on Wall Balls when the parser fell through to Strategy 2).
  const STATION_MAX_SEC = 1500;

  for (const [station, ev] of stationEvents) {
    if (ev.in == null) continue;
    let outSec = ev.out;
    // Wall-Balls fallback: use the finish time-of-day, not the cumulative
    // race duration. Both `ev.in` and `totalEndTimeOfDay` are time-of-day,
    // so subtraction yields the station duration directly.
    if (outSec == null && totalEndTimeOfDay != null && totalEndTimeOfDay > ev.in) {
      outSec = totalEndTimeOfDay;
    }
    if (outSec == null || outSec <= ev.in) continue;
    const dur = outSec - ev.in;
    const minSec = STATION_MIN_SEC[station];
    if (dur >= minSec && dur <= STATION_MAX_SEC) {
      stations[station] = dur;
      stationSource[station] = 'structured';
    }
  }

  // ── Strategy 2: "Station Name  time" single-value format ─────────────────
  for (const { pattern, station } of STATION_PATTERNS) {
    if (station in stations) continue; // already resolved by In/Out strategy
    const nameMatch = pattern.exec(text);
    if (!nameMatch) continue;

    const after = text.slice(nameMatch.index + nameMatch[0].length, nameMatch.index + nameMatch[0].length + 300);
    const sec = extractTimeSec(after);
    if (sec == null) continue;

    // Enforce physical bounds. The upper bound is critical: previously a
    // time-of-day value (e.g. 11:37:02 → 41822s) would slip through and
    // poison the prediction with a 12-hour station total.
    const minSec = STATION_MIN_SEC[station];
    if (sec < minSec || sec > STATION_MAX_SEC) continue;

    stations[station] = sec;
    stationSource[station] = 'fallback';
  }

  // Parse run leg times: lines like "Running 1  00:03:22" or "Run 1  3:22"
  // Average all found run legs to derive a 1km pace. Legs 1 to 8 are also
  // kept by number (first time per leg) for "where you lost time".
  const runLegTimes: number[] = [];
  const runLegsByNumber: Array<number | null> = new Array(8).fill(null);
  const RUN_LINE_RE = /\brun(?:ning)?\s+(\d+)\b/gi;
  let runMatch: RegExpExecArray | null;
  while ((runMatch = RUN_LINE_RE.exec(text)) !== null) {
    const sec = timeNear(runMatch.index + runMatch[0].length, 60);
    if (sec != null && sec >= HYROX_RUN_PACE_MIN_SEC_KM && sec <= 720) { // 3:10–12:00/km
      runLegTimes.push(sec);
      const leg = Number(runMatch[1]);
      if (leg >= 1 && leg <= 8 && runLegsByNumber[leg - 1] == null) runLegsByNumber[leg - 1] = sec;
    }
  }

  let runPaceSecKm: number | undefined;
  if (runLegTimes.length > 0) {
    runPaceSecKm = Math.round(runLegTimes.reduce((s, v) => s + v, 0) / runLegTimes.length);
  }

  // Fallback 1: "Run Total" / "Running Total" → divide by 8 legs to get per-km pace
  if (runPaceSecKm == null) {
    const runTotalMatch = /\brun(?:ning)?\s+total\b/i.exec(text);
    if (runTotalMatch) {
      const after = text.slice(runTotalMatch.index + runTotalMatch[0].length, runTotalMatch.index + runTotalMatch[0].length + 80);
      const sec = extractTimeSec(after);
      if (sec != null) {
        const perLeg = Math.round(sec / 8);
        if (perLeg >= HYROX_RUN_PACE_MIN_SEC_KM && perLeg <= 720) runPaceSecKm = perLeg;
      }
    }
  }

  // Fallback 2: "Best Run Lap" / "Best Run" → fastest 1km lap = best pace achieved
  if (runPaceSecKm == null) {
    const bestMatch = /\bbest\s+run(?:\s+lap)?\b/i.exec(text);
    if (bestMatch) {
      const after = text.slice(bestMatch.index + bestMatch[0].length, bestMatch.index + bestMatch[0].length + 60);
      const sec = extractTimeSec(after);
      if (sec != null && sec >= HYROX_RUN_PACE_MIN_SEC_KM && sec <= 720) {
        // Best lap is fastest, so average pace is ~5% slower
        runPaceSecKm = Math.round(sec * 1.05);
      }
    }
  }

  // Run total: the legs when all 8 were found, else a "Run Total" line
  // (bounded like a leg: 8 x 3:10 to 8 x 12:00).
  let runTotalSec: number | undefined;
  if (runLegsByNumber.every(v => v != null)) {
    runTotalSec = (runLegsByNumber as number[]).reduce((a, b) => a + b, 0);
  } else {
    const runTotalLine = /\brun(?:ning)?\s+total\b/i.exec(text);
    if (runTotalLine) {
      const sec = timeNear(runTotalLine.index + runTotalLine[0].length, 80);
      if (sec != null && sec >= HYROX_RUN_PACE_MIN_SEC_KM * 8 && sec <= 720 * 8) runTotalSec = sec;
    }
  }

  // Roxzone total. "Roxzone In / Out" timestamp lines and numbered
  // transitions are skipped; several bare "Roxzone" times are per-transition
  // and not summed. Same 25-min ceiling as a station (the results' Roxzone
  // p99 is under 20 min in every field).
  let roxzoneSec: number | undefined;
  const roxTotalLine = /\b(?:roxzone\s+(?:time|total)|total\s+roxzone)\b/i.exec(text);
  const roxTimeAfter = (index: number, length: number): number | null => {
    const sec = timeNear(index + length, 60);
    return sec != null && sec > 0 && sec <= STATION_MAX_SEC ? sec : null;
  };
  if (roxTotalLine) {
    roxzoneSec = roxTimeAfter(roxTotalLine.index, roxTotalLine[0].length) ?? undefined;
  } else {
    // Not "Roxzone In/Out" and not a numbered transition ("Roxzone 3 0:24");
    // a time right after the label ("Roxzone 05:48") is fine.
    const BARE_ROX_RE = /\broxzone\b(?!\s*(?:in|out|time|total)\b)(?!\s*\d+\b(?!:))/gi;
    const bare: number[] = [];
    let rm: RegExpExecArray | null;
    while ((rm = BARE_ROX_RE.exec(text)) !== null) {
      const sec = roxTimeAfter(rm.index, rm[0].length);
      if (sec != null) bare.push(sec);
    }
    if (bare.length === 1) roxzoneSec = bare[0];
  }

  return {
    stations,
    stationSource,
    runPaceSecKm,
    totalRaceSec: totalSec ?? undefined,
    ...(runLegsByNumber.some(v => v != null) ? { runLegsSec: runLegsByNumber } : {}),
    ...(runTotalSec != null ? { runTotalSec } : {}),
    ...(roxzoneSec != null ? { roxzoneSec } : {}),
  };
}
