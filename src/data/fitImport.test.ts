/**
 * Tests for single-file FIT / GPX / TCX import.
 *
 * FIT is binary and hard to fixture inline. We test the pure mapping layer
 * (streamsToActivityRow, mapFitSport) against mock records arrays rather
 * than exercising the binary decoder.
 *
 * GPX and TCX are XML. Inline fixtures confirm end-to-end parsing through
 * the DOMParser path.
 */

import { describe, it, expect } from 'vitest';
import {
  mapFitSport,
  parseGpx,
  parseTcx,
  streamsToActivityRow,
  toISO,
  type StreamRecord,
  type ActivitySummary,
} from './fitImport';

// ---------------------------------------------------------------------------
// mapFitSport
// ---------------------------------------------------------------------------

describe('mapFitSport', () => {
  it('maps running to RUNNING', () => {
    expect(mapFitSport('running')).toBe('RUNNING');
  });

  it('maps running + treadmill sub_sport to TREADMILL_RUNNING', () => {
    expect(mapFitSport('running', 'treadmill')).toBe('TREADMILL_RUNNING');
  });

  it('maps cycling to CYCLING', () => {
    expect(mapFitSport('cycling')).toBe('CYCLING');
  });

  it('maps cycling + indoor_cycling sub_sport to INDOOR_CYCLING', () => {
    expect(mapFitSport('cycling', 'indoor_cycling')).toBe('INDOOR_CYCLING');
  });

  it('maps swimming to SWIMMING', () => {
    expect(mapFitSport('swimming')).toBe('SWIMMING');
  });

  it('maps unknown sport to CARDIO', () => {
    expect(mapFitSport('fencing')).toBe('CARDIO');
  });

  it('handles undefined sport gracefully', () => {
    expect(mapFitSport(undefined)).toBe('CARDIO');
  });
});

// ---------------------------------------------------------------------------
// GPX parsing
// ---------------------------------------------------------------------------

const GPX_RUN = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Garmin Connect">
  <metadata><time>2024-05-14T07:00:00Z</time></metadata>
  <trk>
    <name>Morning Run</name>
    <type>running</type>
    <trkseg>
      <trkpt lat="51.5001" lon="-0.1001">
        <time>2024-05-14T07:00:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>142</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="51.5010" lon="-0.1010">
        <time>2024-05-14T07:00:30Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>148</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="51.5020" lon="-0.1020">
        <time>2024-05-14T07:01:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>155</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="51.5100" lon="-0.1100">
        <time>2024-05-14T07:10:00Z</time>
        <extensions>
          <gpxtpx:TrackPointExtension>
            <gpxtpx:hr>162</gpxtpx:hr>
          </gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('parseGpx', () => {
  it('parses trackpoints and extracts HR', () => {
    const { summary, records } = parseGpx(GPX_RUN);
    expect(records.length).toBe(4);
    expect(records[0].heartRate).toBe(142);
    expect(records[2].heartRate).toBe(155);
  });

  it('extracts start time from first trackpoint', () => {
    const { summary } = parseGpx(GPX_RUN);
    expect(summary.startTimeISO).toBe('2024-05-14T07:00:00Z');
  });

  it('maps running type to RUNNING', () => {
    const { summary } = parseGpx(GPX_RUN);
    expect(summary.activityType).toBe('RUNNING');
  });

  it('computes positive distance from haversine chain', () => {
    const { summary } = parseGpx(GPX_RUN);
    expect(summary.distanceM).toBeGreaterThan(0);
  });

  it('computes duration from first to last timestamp', () => {
    const { summary } = parseGpx(GPX_RUN);
    // 07:00:00 to 07:10:00 = 600 seconds
    expect(summary.durationSec).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// GPX with power (cycling)
// ---------------------------------------------------------------------------

const GPX_RIDE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1">
  <trk>
    <type>cycling</type>
    <trkseg>
      <trkpt lat="48.8566" lon="2.3522">
        <time>2024-05-14T09:00:00Z</time>
        <extensions>
          <power>210</power>
          <gpxtpx:TrackPointExtension><gpxtpx:hr>145</gpxtpx:hr></gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="48.8570" lon="2.3530">
        <time>2024-05-14T09:00:30Z</time>
        <extensions>
          <power>225</power>
          <gpxtpx:TrackPointExtension><gpxtpx:hr>150</gpxtpx:hr></gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
      <trkpt lat="48.8575" lon="2.3540">
        <time>2024-05-14T09:01:00Z</time>
        <extensions>
          <power>235</power>
          <gpxtpx:TrackPointExtension><gpxtpx:hr>155</gpxtpx:hr></gpxtpx:TrackPointExtension>
        </extensions>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('parseGpx — cycling with power', () => {
  it('parses power from <power> extension element', () => {
    const { records } = parseGpx(GPX_RIDE);
    expect(records[0].power).toBe(210);
    expect(records[2].power).toBe(235);
  });

  it('maps cycling type to CYCLING', () => {
    const { summary } = parseGpx(GPX_RIDE);
    expect(summary.activityType).toBe('CYCLING');
  });
});

// ---------------------------------------------------------------------------
// TCX parsing
// ---------------------------------------------------------------------------

const TCX_RUN = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase>
  <Activities>
    <Activity Sport="Running">
      <Lap>
        <TotalTimeSeconds>1800</TotalTimeSeconds>
        <DistanceMeters>5000</DistanceMeters>
        <Track>
          <Trackpoint>
            <Time>2024-05-14T06:00:00Z</Time>
            <Position>
              <LatitudeDegrees>51.5000</LatitudeDegrees>
              <LongitudeDegrees>-0.1000</LongitudeDegrees>
            </Position>
            <DistanceMeters>0</DistanceMeters>
            <HeartRateBpm><Value>135</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-05-14T06:01:00Z</Time>
            <Position>
              <LatitudeDegrees>51.5010</LatitudeDegrees>
              <LongitudeDegrees>-0.1010</LongitudeDegrees>
            </Position>
            <DistanceMeters>100</DistanceMeters>
            <HeartRateBpm><Value>140</Value></HeartRateBpm>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-05-14T06:02:00Z</Time>
            <Position>
              <LatitudeDegrees>51.5020</LatitudeDegrees>
              <LongitudeDegrees>-0.1020</LongitudeDegrees>
            </Position>
            <DistanceMeters>210</DistanceMeters>
            <HeartRateBpm><Value>148</Value></HeartRateBpm>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

describe('parseTcx', () => {
  it('parses trackpoints and extracts HR', () => {
    const { summary, records } = parseTcx(TCX_RUN);
    expect(records.length).toBe(3);
    expect(records[0].heartRate).toBe(135);
    expect(records[1].heartRate).toBe(140);
  });

  it('maps Sport="Running" to RUNNING', () => {
    const { summary } = parseTcx(TCX_RUN);
    expect(summary.activityType).toBe('RUNNING');
  });

  it('extracts start time', () => {
    const { summary } = parseTcx(TCX_RUN);
    expect(summary.startTimeISO).toBe('2024-05-14T06:00:00Z');
  });

  it('computes positive distance', () => {
    const { summary } = parseTcx(TCX_RUN);
    expect(summary.distanceM).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TCX with power (cycling)
// ---------------------------------------------------------------------------

const TCX_RIDE = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase>
  <Activities>
    <Activity Sport="Biking">
      <Lap>
        <Track>
          <Trackpoint>
            <Time>2024-05-14T10:00:00Z</Time>
            <DistanceMeters>0</DistanceMeters>
            <HeartRateBpm><Value>130</Value></HeartRateBpm>
            <Extensions><ns3:Watts>180</ns3:Watts></Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-05-14T10:00:30Z</Time>
            <DistanceMeters>250</DistanceMeters>
            <HeartRateBpm><Value>138</Value></HeartRateBpm>
            <Extensions><ns3:Watts>195</ns3:Watts></Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2024-05-14T10:01:00Z</Time>
            <DistanceMeters>510</DistanceMeters>
            <HeartRateBpm><Value>145</Value></HeartRateBpm>
            <Extensions><ns3:Watts>205</ns3:Watts></Extensions>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

describe('parseTcx — cycling with power', () => {
  it('parses <ns3:Watts> power extension', () => {
    const { records } = parseTcx(TCX_RIDE);
    expect(records[0].power).toBe(180);
    expect(records[2].power).toBe(205);
  });

  it('maps Biking sport to CYCLING', () => {
    const { summary } = parseTcx(TCX_RIDE);
    expect(summary.activityType).toBe('CYCLING');
  });
});

// ---------------------------------------------------------------------------
// streamsToActivityRow. Pure mapping (mock records, no state, no HealthKit)
// ---------------------------------------------------------------------------

function makeRunSummary(): ActivitySummary {
  return {
    startTimeISO: '2024-05-14T07:00:00Z',
    durationSec: 1800,
    distanceM: 5000,
    activityType: 'RUNNING',
    calories: 350,
  };
}

function makeRunRecords(): StreamRecord[] {
  // 30 HR samples, one every minute from second 0 to 1800
  const records: StreamRecord[] = [];
  const t0 = new Date('2024-05-14T07:00:00Z').getTime();
  for (let i = 0; i < 30; i++) {
    records.push({
      timestamp: new Date(t0 + i * 60_000).toISOString(),
      heartRate: 140 + Math.floor(i / 10),
      lat: 51.5 + i * 0.001,
      lng: -0.1 - i * 0.001,
      distanceM: i * (5000 / 30),
    });
  }
  return records;
}

describe('streamsToActivityRow', () => {
  it('sets garmin_id with import- prefix', () => {
    const row = streamsToActivityRow(makeRunSummary(), makeRunRecords(), null, null, 30, undefined);
    expect(row.garmin_id.startsWith('import-')).toBe(true);
  });

  it('sets activity_type from summary', () => {
    const row = streamsToActivityRow(makeRunSummary(), makeRunRecords(), null, null, 30, undefined);
    expect(row.activity_type).toBe('RUNNING');
  });

  it('sets distance_m from summary', () => {
    const row = streamsToActivityRow(makeRunSummary(), makeRunRecords(), null, null, 30, undefined);
    expect(row.distance_m).toBe(5000);
  });

  it('sets duration_sec from summary', () => {
    const row = streamsToActivityRow(makeRunSummary(), makeRunRecords(), null, null, 30, undefined);
    expect(row.duration_sec).toBe(1800);
  });

  it('computes avg_hr from HR stream when restingHR/maxHR absent', () => {
    const row = streamsToActivityRow(makeRunSummary(), makeRunRecords(), null, null, 30, undefined);
    // Stream HR values are 140/141/142. Avg should be in that range
    expect(row.avg_hr).toBeGreaterThanOrEqual(140);
    expect(row.avg_hr).toBeLessThanOrEqual(142);
  });

  it('computes iTRIMP when restingHR and age are provided (Tanaka fallback)', () => {
    // age 30 → Tanaka maxHR = round(208 - 0.7 * 30) = 187
    const row = streamsToActivityRow(makeRunSummary(), makeRunRecords(), 50, null, 30, 'male');
    // iTRIMP should be a positive number when HR data exists and HR params are set
    expect(row.iTrimp).toBeGreaterThan(0);
  });

  it('sets averageWatts for a cycling row with power stream', () => {
    const summary: ActivitySummary = {
      startTimeISO: '2024-05-14T09:00:00Z',
      durationSec: 3600,
      distanceM: 40_000,
      activityType: 'CYCLING',
    };
    const t0 = new Date(summary.startTimeISO).getTime();
    const records: StreamRecord[] = Array.from({ length: 60 }, (_, i) => ({
      timestamp: new Date(t0 + i * 60_000).toISOString(),
      heartRate: 150,
      power: 200 + i,  // watts increasing from 200 to 259
    }));
    const row = streamsToActivityRow(summary, records, 55, 185, 35, 'male');
    expect(row.averageWatts).toBeGreaterThan(0);
    expect(row.deviceWatts).toBe(true);
  });

  it('returns null iTrimp when HR stream has fewer than 2 samples', () => {
    const summary = makeRunSummary();
    const records: StreamRecord[] = [{ timestamp: summary.startTimeISO }]; // no HR
    const row = streamsToActivityRow(summary, records, 50, 185, 30, 'male');
    expect(row.iTrimp).toBeNull();
  });
});

describe('toISO — fit-file-parser timestamp coercion', () => {
  it('converts a Date object to an ISO string (the real FIT case)', () => {
    const d = new Date('2026-05-19T07:00:00.000Z');
    expect(toISO(d)).toBe('2026-05-19T07:00:00.000Z');
    expect(typeof toISO(d)).toBe('string');
  });

  it('passes an ISO string through unchanged', () => {
    expect(toISO('2026-05-19T07:00:00.000Z')).toBe('2026-05-19T07:00:00.000Z');
  });

  it('converts an epoch-ms number to an ISO string', () => {
    expect(toISO(Date.UTC(2026, 4, 19, 7, 0, 0))).toBe('2026-05-19T07:00:00.000Z');
  });

  it('output of a Date is safe for the .replace() call that builds garmin_id', () => {
    // Regression: parseFit handed a Date straight to startTimeISO, and
    // streamsToActivityRow does startTimeISO.replace(...) → "replace is not a
    // function". A coerced value must be a string with a working .replace.
    const iso = toISO(new Date('2026-05-19T07:00:00.000Z'));
    expect(() => iso.replace(/[^0-9T]/g, '')).not.toThrow();
    expect(iso.replace(/[^0-9T]/g, '').slice(0, 15)).toBe('20260519T070000');
  });
});
