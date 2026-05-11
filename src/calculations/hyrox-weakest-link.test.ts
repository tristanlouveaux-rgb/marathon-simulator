import { describe, expect, it } from 'vitest';
import { rankWeakestLinks, topWeakestLinks } from './hyrox-weakest-link';
import type { HyroxPrediction } from './race-prediction.hyrox';

function build(stations: Array<{
  station: string;
  currentSec: number;
  projectedSec: number;
  improvementPct?: number;
  source?: 'calibrated' | 'seed';
}>, weeksRemaining = 8): HyroxPrediction {
  return {
    projection: {
      stations: stations.map(s => ({
        station: s.station as never,
        currentSec: s.currentSec,
        projectedSec: s.projectedSec,
        improvementPct: s.improvementPct ?? ((s.currentSec - s.projectedSec) / s.currentSec) * 100,
        source: s.source ?? 'calibrated',
      })),
      roxzone: { currentSec: 60, projectedSec: 58, improvementPct: 3 },
      weeksRemaining,
      plannedSessionsPerWeek: 4,
    },
  } as unknown as HyroxPrediction;
}

describe('rankWeakestLinks', () => {
  it('returns empty when prediction is null', () => {
    expect(rankWeakestLinks(null)).toEqual([]);
  });

  it('returns empty when projection missing', () => {
    expect(rankWeakestLinks({} as HyroxPrediction)).toEqual([]);
  });

  it('returns empty when race day already passed (weeksRemaining=0)', () => {
    const p = build([
      { station: 'wall_balls', currentSec: 240, projectedSec: 220 },
    ], 0);
    expect(rankWeakestLinks(p)).toEqual([]);
  });

  it('ranks by absolute gainableSec descending', () => {
    const p = build([
      { station: 'wall_balls', currentSec: 240, projectedSec: 230 },   // gain 10
      { station: 'sled_push',  currentSec: 130, projectedSec: 100 },   // gain 30
      { station: 'ski_erg',    currentSec: 280, projectedSec: 260 },   // gain 20
    ]);
    const ranked = rankWeakestLinks(p);
    expect(ranked.map(r => r.station)).toEqual(['sled_push', 'ski_erg', 'wall_balls']);
  });

  it('drops zero-gain entries (no improvement realistic)', () => {
    const p = build([
      { station: 'wall_balls', currentSec: 240, projectedSec: 240 }, // no gain
      { station: 'sled_push',  currentSec: 130, projectedSec: 120 },
    ]);
    const ranked = rankWeakestLinks(p);
    expect(ranked.map(r => r.station)).toEqual(['sled_push']);
  });

  it('preserves source in result', () => {
    const p = build([
      { station: 'wall_balls', currentSec: 240, projectedSec: 220, source: 'seed' },
      { station: 'sled_push',  currentSec: 130, projectedSec: 100, source: 'calibrated' },
    ]);
    const ranked = rankWeakestLinks(p);
    expect(ranked[0].source).toBe('calibrated');
    expect(ranked[1].source).toBe('seed');
  });
});

describe('topWeakestLinks', () => {
  it('returns top N entries', () => {
    const p = build([
      { station: 'wall_balls', currentSec: 240, projectedSec: 230 },
      { station: 'sled_push',  currentSec: 130, projectedSec: 100 },
      { station: 'ski_erg',    currentSec: 280, projectedSec: 260 },
      { station: 'row_erg',    currentSec: 270, projectedSec: 265 },
    ]);
    const top = topWeakestLinks(p, 2);
    expect(top.length).toBe(2);
    expect(top.map(r => r.station)).toEqual(['sled_push', 'ski_erg']);
  });
});
