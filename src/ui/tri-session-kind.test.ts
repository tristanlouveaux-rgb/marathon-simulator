/**
 * Regression: the tri Today-card badge must not label non-run sessions "Run".
 *
 * buildTriathlonSessionBlock previously defaulted any workout without a
 * `discipline` field (and not gym/strength) to the "Run" badge. Synced actuals
 * (t:'easy'|'gym'|'cross', no discipline) and injury substitutes without a
 * discipline lane (row erg) all badged as "Run" — an injured athlete's logged
 * walk/ride/gym day read as "3 runs today" (2026-07-26 report).
 */
import { describe, it, expect } from 'vitest';
import { triSessionKind } from './home-view';

describe('triSessionKind', () => {
  it('discipline field wins', () => {
    expect(triSessionKind({ discipline: 'swim', t: 'x' })).toBe('swim');
    expect(triSessionKind({ discipline: 'bike', t: 'x' })).toBe('bike');
    expect(triSessionKind({ discipline: 'run', t: 'x' })).toBe('run');
  });

  it('type tokens are sniffed when discipline is absent', () => {
    expect(triSessionKind({ t: 'swim_threshold' })).toBe('swim');
    expect(triSessionKind({ t: 'bike_endurance' })).toBe('bike');
    expect(triSessionKind({ t: 'brick' })).toBe('bike'); // brick belongs to bike for scheduling
    expect(triSessionKind({ t: 'run_easy' })).toBe('run');
    expect(triSessionKind({ t: 'easy' })).toBe('run');
    expect(triSessionKind({ t: 'gym' })).toBe('strength');
    expect(triSessionKind({ t: 'strength' })).toBe('strength');
  });

  it('unknown / discipline-less sessions fall back to cross, NOT run', () => {
    expect(triSessionKind({ t: 'cross' })).toBe('cross');            // synced non-run actual
    expect(triSessionKind({ t: '' })).toBe('cross');
    expect(triSessionKind({ t: 'row_erg' })).toBe('cross');          // injury substitute, no discipline lane
    expect(triSessionKind({ t: 'walk' })).toBe('cross');
  });

  it('strength name heuristic still applies', () => {
    expect(triSessionKind({ t: 'x', n: 'Core Strength Circuit' })).toBe('strength');
  });
});
