/**
 * The pure merge at the heart of cross-device enrichment sync: apply server
 * enrichment payloads onto local activities by garminId, rich-over-thin only.
 * The network paths (push/fetch) are thin Supabase wrappers tested manually on
 * device; the merge rule is where the safety guarantees live, so it is unit
 * tested here.
 */

import { describe, it, expect } from 'vitest';
import { applyEnrichmentPayloads, type EnrichPayload } from './enrichmentSync';
import type { GarminActual } from '@/types';

function thin(over: Partial<GarminActual> = {}): GarminActual {
  return {
    garminId: 'apple-A',
    startTime: '2026-06-01T07:00:00Z',
    distanceKm: 10,
    durationSec: 3000,
    avgPaceSecKm: 300,
    avgHR: 150,
    maxHR: null,
    calories: null,
    iTrimp: null,
    hrZones: null,
    polyline: null,
    kmSplits: null,
    ...over,
  };
}

const RICH: EnrichPayload = {
  iTrimp: 9000,
  hrZones: { z1: 1, z2: 2, z3: 3, z4: 4, z5: 5 },
  kmSplits: [300, 300],
  polyline: 'abc',
  enrichedFromFile: true,
};

function wk(actuals: Record<string, GarminActual>) {
  return [{ garminActuals: actuals }];
}

describe('applyEnrichmentPayloads', () => {
  it('fills a thin local activity from the matching server payload', () => {
    const a = thin({ garminId: 'apple-A' });
    const applied = applyEnrichmentPayloads(wk({ W1: a }), new Map([['apple-A', RICH]]));
    expect(applied).toBe(1);
    expect(a.hrZones).toEqual(RICH.hrZones);
    expect(a.polyline).toBe('abc');
    expect(a.iTrimp).toBe(9000);
    expect(a.enrichedFromFile).toBe(true);
  });

  it('does not touch an activity that is already rich (no downgrade)', () => {
    const a = thin({ garminId: 'apple-A', polyline: 'local-route', hrZones: { z1: 9, z2: 9, z3: 9, z4: 9, z5: 9 } });
    const applied = applyEnrichmentPayloads(wk({ W1: a }), new Map([['apple-A', RICH]]));
    expect(applied).toBe(0);
    expect(a.polyline).toBe('local-route'); // untouched
  });

  it('ignores payloads with no matching local garminId', () => {
    const a = thin({ garminId: 'apple-A' });
    const applied = applyEnrichmentPayloads(wk({ W1: a }), new Map([['apple-OTHER', RICH]]));
    expect(applied).toBe(0);
    expect(a.hrZones).toBeNull();
  });

  it('is idempotent: a second merge applies nothing (now no longer thin)', () => {
    const a = thin({ garminId: 'apple-A' });
    const map = new Map([['apple-A', RICH]]);
    expect(applyEnrichmentPayloads(wk({ W1: a }), map)).toBe(1);
    expect(applyEnrichmentPayloads(wk({ W1: a }), map)).toBe(0);
  });

  it('never matches a Strava-sourced row (already rich by provenance)', () => {
    const a = thin({ garminId: 'strava-123' });
    const applied = applyEnrichmentPayloads(wk({ W1: a }), new Map([['strava-123', RICH]]));
    expect(applied).toBe(0);
  });
});
