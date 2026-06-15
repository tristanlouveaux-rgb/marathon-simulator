/**
 * End-to-end verification of per-activity file enrichment, beyond the pure-merge
 * unit tests. Two things the unit tests do NOT cover:
 *
 *  1. REAL parse path: a real GPX → parseGpx → streamsToActivityRow → the merge.
 *     Proves the field names produced by the parser line up with what
 *     enrichActualFromParsedRow reads (a hand-built row could hide a mismatch).
 *
 *  2. The matcher re-enrich GUARD: matchAndAutoComplete is run for real against a
 *     thin re-synced Apple Health row to prove a file-enriched iTRIMP survives
 *     (and a non-enriched one is still updated — the control proves the loop
 *     actually fires, so test 1's pass is meaningful).
 */

import { describe, it, expect, vi } from 'vitest';
import { parseGpx, streamsToActivityRow, ingestActivityFile } from './fitImport';
import { enrichActualFromParsedRow } from './activity-enrich-merge';
import { getDefaultState, setState, getMutableState } from '@/state/store';
import { matchAndAutoComplete, type GarminActivityRow } from '@/calculations/activity-matcher';
import type { GarminActual } from '@/types';

// ingestActivityFile re-renders the current view on a successful enrich; the
// renderer needs a live DOM we don't have in a unit test, so stub it out.
vi.mock('@/ui/renderer', () => ({ render: () => {} }));

// A real GPX with HR samples ~30s apart over ~10 min, covering ~1.5 km. Enough
// for the parser to emit a polyline + km splits + HR enrichment.
const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect">
  <metadata><time>2026-06-01T07:00:00Z</time></metadata>
  <trk><name>Morning Run</name><type>running</type><trkseg>
    <trkpt lat="51.5000" lon="-0.1000"><time>2026-06-01T07:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="51.5025" lon="-0.1025"><time>2026-06-01T07:00:30Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>148</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="51.5050" lon="-0.1050"><time>2026-06-01T07:01:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>152</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="51.5075" lon="-0.1075"><time>2026-06-01T07:01:30Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>156</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="51.5100" lon="-0.1100"><time>2026-06-01T07:02:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>158</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="51.5150" lon="-0.1150"><time>2026-06-01T07:05:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>160</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    <trkpt lat="51.5200" lon="-0.1200"><time>2026-06-01T07:10:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>162</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  </trkseg></trk>
</gpx>`;

describe('real GPX → streamsToActivityRow → enrich (field alignment)', () => {
  it('a thin activity gains the parsed route in place', () => {
    const { summary, records } = parseGpx(GPX);
    const row = streamsToActivityRow(summary, records, 50, 190, 30, 'male');

    // The parser must actually have produced a route to enrich with.
    expect(row.polyline).toBeTruthy();

    // Thin actual = same session, no rich fields. Match the parsed start/duration
    // exactly so the guard passes and we isolate the field-mapping behaviour.
    const actual: GarminActual = {
      garminId: 'apple-GPX1',
      startTime: row.start_time,
      distanceKm: (row.distance_m ?? 0) / 1000,
      durationSec: row.duration_sec,
      avgPaceSecKm: row.avg_pace_sec_km,
      avgHR: row.avg_hr,
      maxHR: null,
      calories: null,
      iTrimp: null,
      hrZones: null,
      polyline: null,
      kmSplits: null,
    };

    const res = enrichActualFromParsedRow(actual, row);
    expect(res.accepted).toBe(true);
    // The headline proof: the real parser's polyline maps straight into the patch.
    expect(res.patch?.polyline).toBe(row.polyline);
    expect(res.added).toContain('route');
    // enrichedFromFile is always stamped on accept.
    expect(res.patch?.enrichedFromFile).toBe(true);
  });
});

// ── Matcher re-enrich guard (the critical fix) ───────────────────────────────

function baseState() {
  const s = getDefaultState();
  s.restingHR = 50;
  s.maxHR = 190;
  s.biologicalSex = 'male';
  s.planStartDate = '2026-05-26';
  return s;
}

function enrichedAppleActual(over: Partial<GarminActual> = {}): GarminActual {
  return {
    garminId: 'apple-RESYNC1',
    startTime: '2026-06-01T07:00:00Z',
    distanceKm: 10,
    durationSec: 3000,
    avgPaceSecKm: 300,
    avgHR: 150,
    maxHR: 175,
    calories: 500,
    iTrimp: 9000, // stream-computed value from the enrichment file
    hrZones: { z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 },
    polyline: 'enriched_poly',
    kmSplits: [300, 300],
    enrichedFromFile: true,
    ...over,
  };
}

// The thin row Apple Health re-delivers on the next sync: no stream iTRIMP, just
// avg HR. resolveITrimp will compute a summary estimate from it (≠ 9000).
function thinResyncRow(): GarminActivityRow {
  return {
    garmin_id: 'apple-RESYNC1',
    activity_type: 'RUNNING',
    start_time: '2026-06-01T07:00:00Z',
    duration_sec: 3000,
    distance_m: 10000,
    avg_pace_sec_km: 300,
    avg_hr: 150,
    max_hr: 175,
    calories: 500,
    aerobic_effect: null,
    anaerobic_effect: null,
    iTrimp: null,
    hrZones: null,
  };
}

describe('ingestActivityFile auto-attach (the "easiest from phone" brain)', () => {
  it('enriches the matching thin run in place, without the user finding it', async () => {
    const s = baseState();
    const thin: GarminActual = {
      garminId: 'apple-INGEST1',
      startTime: '2026-06-01T07:00:00Z',
      distanceKm: 1.5,
      durationSec: 600,
      avgPaceSecKm: 400,
      avgHR: 150,
      maxHR: null,
      calories: null,
      iTrimp: null,
      hrZones: null,
      polyline: null,
      kmSplits: null,
    };
    s.wks = [{ garminActuals: { W1: thin }, garminMatched: { 'apple-INGEST1': 'W1' } } as any];
    setState(s);

    const file = new File([GPX], 'morning-run.gpx', { type: 'application/gpx+xml' });
    const res = await ingestActivityFile(file);

    expect(res.outcome).toBe('enriched');
    const after = getMutableState().wks![0].garminActuals!.W1;
    expect(after.polyline).toBeTruthy();          // route attached in place
    expect(after.garminId).toBe('apple-INGEST1'); // provenance preserved
    expect(after.enrichedFromFile).toBe(true);
  });

  it('imports as a new activity when no thin run matches', async () => {
    const s = baseState();
    s.wks = [{ garminActuals: {}, garminMatched: {} } as any];
    setState(s);

    const file = new File([GPX], 'orphan-run.gpx', { type: 'application/gpx+xml' });
    const res = await ingestActivityFile(file);

    expect(res.outcome).toBe('imported');
  });
});

describe('matchAndAutoComplete re-enrich guard', () => {
  it('preserves a file-enriched iTRIMP when Apple Health re-syncs the thin row', () => {
    const s = baseState();
    s.wks = [{
      garminActuals: { W1: enrichedAppleActual({ enrichedFromFile: true }) },
      garminMatched: { 'apple-RESYNC1': 'W1' },
    } as any];
    setState(s);

    matchAndAutoComplete([thinResyncRow()]);

    expect(getMutableState().wks![0].garminActuals!.W1.iTrimp).toBe(9000);
  });

  it('CONTROL: a non-enriched actual still has its iTRIMP refreshed (loop fires)', () => {
    const s = baseState();
    s.wks = [{
      garminActuals: { W1: enrichedAppleActual({ enrichedFromFile: false }) },
      garminMatched: { 'apple-RESYNC1': 'W1' },
    } as any];
    setState(s);

    matchAndAutoComplete([thinResyncRow()]);

    const after = getMutableState().wks![0].garminActuals!.W1.iTrimp;
    expect(after).not.toBe(9000);
    expect(after).toBeGreaterThan(0);
  });
});
