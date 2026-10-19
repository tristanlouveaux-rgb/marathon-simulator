import { describe, it, expect } from 'vitest';
import { parseHyroxResultsText } from './hyrox-results-parse';

/**
 * These guard the iPhone copy-paste flow: a phone user cannot reliably "Select
 * All" on a rendered results page, so the realistic input is a ROUGH, PARTIAL
 * selection sprinkled with navigation chrome. The parser must pick station
 * times out of that noise and ignore everything else, filling whatever it can
 * rather than failing on an imperfect copy.
 */
describe('parseHyroxResultsText — forgiving phone copy', () => {
  it('extracts station times from a messy partial copy with junk lines', () => {
    // Simulates a sloppy mobile selection: site chrome, blank lines, only some
    // of the stations grabbed, inconsistent spacing.
    const messy = `
      HYROX  Menu  Login
      Results  Rankings
      SkiErg        04:12
      Sled Push     02:48

      Rowing   04:31
      Wall Balls    05:55
      Share   Download PDF
    `;
    const { stations, stationSource } = parseHyroxResultsText(messy);
    expect(stations.ski_erg).toBe(4 * 60 + 12);
    expect(stations.sled_push).toBe(2 * 60 + 48);
    expect(stations.row_erg).toBe(4 * 60 + 31);
    expect(stations.wall_balls).toBe(5 * 60 + 55);
    // Unselected stations simply stay absent — no crash, no garbage.
    expect(stations.sandbag_lunges).toBeUndefined();
    expect(Object.keys(stations)).toHaveLength(4);
    // Single-value lines come from the looser fallback scan, so the UI should
    // flag them for review.
    expect(stationSource.ski_erg).toBe('fallback');
    expect(stationSource.wall_balls).toBe('fallback');
  });

  it('marks In/Out timestamp-pair stations as structured (high confidence)', () => {
    // Timing-system export: each station has an In and Out time-of-day line.
    // Duration = Out − In, so these are reliable, not flagged.
    const exportText = `
      SkiErg In    10:43:16
      SkiErg Out   10:47:28
      Sled Push In  10:48:01
      Sled Push Out 10:50:49
    `;
    const { stations, stationSource } = parseHyroxResultsText(exportText);
    expect(stations.ski_erg).toBe(4 * 60 + 12);
    expect(stations.sled_push).toBe(2 * 60 + 48);
    expect(stationSource.ski_erg).toBe('structured');
    expect(stationSource.sled_push).toBe('structured');
  });

  it('handles h:mm:ss timing-export values and a total line', () => {
    const txt = `
      SkiErg      00:04:12
      Sled Push   00:02:48
      Total time  01:02:30
    `;
    const { stations, totalRaceSec } = parseHyroxResultsText(txt);
    expect(stations.ski_erg).toBe(252);
    expect(stations.sled_push).toBe(168);
    expect(totalRaceSec).toBe(3750);
  });

  it('returns an empty result (no throw) when the copy has no times', () => {
    const { stations, runPaceSecKm, totalRaceSec } = parseHyroxResultsText('just some random text the user grabbed by mistake');
    expect(Object.keys(stations)).toHaveLength(0);
    expect(runPaceSecKm).toBeUndefined();
    expect(totalRaceSec).toBeUndefined();
  });
});

describe('parseHyroxResultsText — run legs and Roxzone for "where you lost time"', () => {
  const fullCopy = `
    Running 1   00:04:31
    1000m SkiErg   00:04:47
    Running 2   00:04:52
    50m Sled Push   00:03:05
    Running 3   00:05:10
    50m Sled Pull   00:05:20
    Running 4   00:05:02
    80m Burpee Broad Jump   00:05:40
    Running 5   00:05:15
    1000m Row   00:04:58
    Running 6   00:05:08
    200m Farmers Carry   00:02:05
    Running 7   00:05:12
    100m Sandbag Lunges   00:05:01
    Running 8   00:05:44
    Wall Balls   00:06:30
    Roxzone Time   00:06:12
    Run Total   00:40:54
    Total time  01:30:02
  `;

  it('keeps each run leg by number and sums the run total from them', () => {
    const r = parseHyroxResultsText(fullCopy);
    expect(r.runLegsSec).toEqual([271, 292, 310, 302, 315, 308, 312, 344]);
    expect(r.runTotalSec).toBe(271 + 292 + 310 + 302 + 315 + 308 + 312 + 344);
    expect(r.roxzoneSec).toBe(372);
    expect(r.totalRaceSec).toBe(5402);
    // The station times are unchanged by the run and Roxzone lines.
    expect(r.stations.ski_erg).toBe(287);
    expect(r.stations.row_erg).toBe(298);
    expect(Object.keys(r.stations)).toHaveLength(8);
  });

  it('a partial copy keeps the legs it found; a Run Total line gives the total', () => {
    const r = parseHyroxResultsText(`
      Running 1  04:31
      Running 3  05:10
      Run Total  00:40:54
    `);
    expect(r.runLegsSec).toEqual([271, null, 310, null, null, null, null, null]);
    expect(r.runTotalSec).toBe(2454);
  });

  it('Roxzone In/Out timestamps and numbered transitions are not a Roxzone total', () => {
    const exportText = `
      SkiErg In    10:43:16
      SkiErg Out   10:47:28
      Roxzone In   10:47:30
      Roxzone Out  10:48:01
    `;
    expect(parseHyroxResultsText(exportText).roxzoneSec).toBeUndefined();
    expect(parseHyroxResultsText('Roxzone 1  0:24\nRoxzone 2  0:31').roxzoneSec).toBeUndefined();
  });

  it('one bare Roxzone line is the total; several are per-transition and not summed', () => {
    expect(parseHyroxResultsText('Roxzone   05:48').roxzoneSec).toBe(348);
    expect(parseHyroxResultsText('Roxzone 0:24\nSkiErg 4:40\nRoxzone 0:31').roxzoneSec).toBeUndefined();
  });

  it('no run or Roxzone lines: the fields are absent', () => {
    const r = parseHyroxResultsText('SkiErg 04:12\nSled Push 02:48');
    expect(r.runLegsSec).toBeUndefined();
    expect(r.runTotalSec).toBeUndefined();
    expect(r.roxzoneSec).toBeUndefined();
  });
});
