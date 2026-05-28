/**
 * Bulk archive (.zip) import — the "bring all my history" path.
 *
 * Covers the novel, error-prone logic: zip walking with nested-zip recursion
 * (Garmin's UploadedFiles_*.zip), per-file gzip handling (Strava's .gpx.gz),
 * activity-extension filtering, and format dispatch. FIT is binary and not
 * fixtured here; GPX exercises the same collect/dispatch path.
 */

import { describe, it, expect } from 'vitest';
import { zipSync, gzipSync, strToU8 } from 'fflate';
import { collectArchiveEntries, parseArchiveEntry } from './fitImport';

function makeGpx(dateISO: string): string {
  const t0 = new Date(dateISO).getTime();
  const pt = (i: number, hr: number) =>
    `<trkpt lat="51.50${i}" lon="-0.10${i}"><time>${new Date(t0 + i * 30000).toISOString()}</time>` +
    `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${hr}</gpxtpx:hr>` +
    `</gpxtpx:TrackPointExtension></extensions></trkpt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test"><metadata><time>${dateISO}</time></metadata>
<trk><type>running</type><trkseg>${pt(1, 140)}${pt(2, 150)}${pt(3, 158)}</trkseg></trk></gpx>`;
}

describe('collectArchiveEntries', () => {
  it('collects plain, gzipped, and nested-zip activity files; skips junk', () => {
    const nested = zipSync({ 'act3.gpx': strToU8(makeGpx('2026-01-03T07:00:00Z')) });
    const archive = zipSync({
      'activities/run1.gpx': strToU8(makeGpx('2026-01-01T07:00:00Z')),
      'activities/run2.gpx.gz': gzipSync(strToU8(makeGpx('2026-01-02T07:00:00Z'))),
      'README.txt': strToU8('not an activity'),
      'UploadedFiles_0-Part1.zip': nested,
    });

    const out: { name: string; data: Uint8Array }[] = [];
    collectArchiveEntries(archive, out);

    const names = out.map(e => e.name).sort();
    expect(out).toHaveLength(3);
    expect(names).toEqual(['act3.gpx', 'activities/run1.gpx', 'activities/run2.gpx.gz']);
  });

  it('does not throw on a non-zip buffer', () => {
    const out: { name: string; data: Uint8Array }[] = [];
    expect(() => collectArchiveEntries(strToU8('garbage, not a zip'), out)).not.toThrow();
    expect(out).toHaveLength(0);
  });
});

describe('parseArchiveEntry', () => {
  it('parses a plain .gpx entry', async () => {
    const parsed = await parseArchiveEntry('run.gpx', strToU8(makeGpx('2026-01-01T07:00:00Z')));
    expect(parsed).not.toBeNull();
    expect(parsed!.records.length).toBeGreaterThanOrEqual(3);
  });

  it('transparently gunzips a .gpx.gz entry', async () => {
    const gz = gzipSync(strToU8(makeGpx('2026-01-02T07:00:00Z')));
    const parsed = await parseArchiveEntry('run.gpx.gz', gz);
    expect(parsed).not.toBeNull();
    expect(parsed!.records.length).toBeGreaterThanOrEqual(3);
  });

  it('returns null for a non-activity file', async () => {
    const parsed = await parseArchiveEntry('README.txt', strToU8('hello'));
    expect(parsed).toBeNull();
  });
});
