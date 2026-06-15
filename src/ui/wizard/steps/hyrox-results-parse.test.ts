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
