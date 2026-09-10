import { describe, it, expect } from 'vitest';
import { collectRecentActivities } from '@/coach/coach-context-builder';
import type { SimulatorState, GarminActual } from '@/types/state';

/** Anchor test: Strava API Agreement §5.3 forbids sending Strava-sourced data
 *  to any AI service, even with user consent. The coach context must therefore
 *  exclude every actual whose garminId carries the `strava-` provenance prefix.
 *  support.html states this publicly. If this test fails, fix the producer.
 *  Do not loosen the anchor. */

function act(garminId: string, day: string): GarminActual {
  return {
    garminId,
    startTime: `2026-08-0${day}T08:00:00Z`,
    distanceKm: 10,
    durationSec: 3000,
    avgPaceSecKm: 300,
    avgHR: 150,
    maxHR: 170,
  } as GarminActual;
}

describe('coach context Strava exclusion', () => {
  it('drops strava- prefixed actuals and keeps other sources', () => {
    const wks = [
      {
        garminActuals: {
          'strava-123': act('strava-123', '1'),
          'garmin-456': act('garmin-456', '2'),
          'apple-789': act('apple-789', '3'),
        },
      },
    ] as unknown as SimulatorState['wks'];

    const results = collectRecentActivities(wks, 0, 4, 10);

    expect(results).toHaveLength(2);
    const dates = results.map(r => r?.date);
    expect(dates).toContain('2026-08-02');
    expect(dates).toContain('2026-08-03');
    expect(dates).not.toContain('2026-08-01');
  });
});
