import { describe, it, expect } from 'vitest';
import {
  lookupEmpiricalTransitions,
  lookupTransitionFieldContext,
} from './empirical-transitions';

// All assertions run against the real ingested distribution
// (`empirical-transition-distributions.json`, 1.3M historical finishes), per
// the project rule that visualisations/derivations of real data come from the
// data itself. Centres are on swim+bike+run moving time in seconds.

const H = (hours: number) => Math.round(hours * 3600);

describe('lookupEmpiricalTransitions', () => {
  it('falls back to the global field for an unknown venue', () => {
    const r = lookupEmpiricalTransitions('Totally Made Up Race', '70.3', H(5));
    expect(r.source).toBe('global-empirical');
    expect(r.transitionSec).toBeGreaterThan(0);
    expect(r.t1Sec).toBeGreaterThan(0);
    expect(r.t2Sec).toBeGreaterThan(0);
  });

  it('matches a known venue to its own bins', () => {
    const r = lookupEmpiricalTransitions('IRONMAN 70.3 World Championship', '70.3', H(5));
    expect(r.source).toBe('race-empirical');
    expect(r.n).toBeGreaterThan(0);
  });

  it('returns a combined transition for Ironman (no per-side columns)', () => {
    const r = lookupEmpiricalTransitions('Totally Made Up Race', 'ironman', H(12));
    expect(r.source).toBe('global-empirical');
    expect(r.transitionSec).toBeGreaterThan(0);
    expect(r.t1Sec).toBeUndefined();
    expect(r.t2Sec).toBeUndefined();
  });
});

describe('lookupTransitionFieldContext', () => {
  it('exposes the field mean as an alias of transitionSec', () => {
    const r = lookupTransitionFieldContext('Made Up', '70.3', H(5));
    expect(r.fieldMeanSec).toBe(r.transitionSec);
  });

  it('carries the dataset size on the global fallback', () => {
    const r = lookupTransitionFieldContext('Made Up', '70.3', H(5));
    expect(r.datasetFinishers).toBeGreaterThan(500_000);
  });

  it('offers a faster reference band for a mid/back-of-pack athlete', () => {
    const r = lookupTransitionFieldContext('Made Up', '70.3', H(7));
    expect(r.fastRef).toBeDefined();
    // The reference is genuinely faster on both axes.
    expect(r.fastRef!.binCenterSec).toBeLessThan(r.binCenterSec!);
    expect(r.fastRef!.fieldMeanSec).toBeLessThan(r.fieldMeanSec!);
  });

  it('omits the faster reference when the athlete is already the fastest band', () => {
    // Below the fastest populated bin centre, no faster band exists to show.
    const r = lookupTransitionFieldContext('Made Up', '70.3', H(3.5));
    expect(r.fastRef).toBeUndefined();
  });

  it('reports venue finishers when matched to a real race', () => {
    const r = lookupTransitionFieldContext('IRONMAN 70.3 World Championship', '70.3', H(5));
    expect(r.source).toBe('race-empirical');
    expect(r.venueFinishers).toBeGreaterThan(0);
    expect(r.n).toBeGreaterThan(0);
  });

  it('works for Ironman with a combined field mean', () => {
    const r = lookupTransitionFieldContext('Made Up', 'ironman', H(13));
    expect(r.fieldMeanSec).toBeGreaterThan(0);
    expect(r.fastRef?.fieldMeanSec).toBeLessThan(r.fieldMeanSec!);
  });
});
