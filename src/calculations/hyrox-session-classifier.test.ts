import { describe, it, expect } from 'vitest';
import {
  classifyHyroxSessionKind,
  classifyHyroxActual,
  formatActivityType,
} from './hyrox-session-classifier';
import type { Workout } from '@/types/state';

const run = (activityType: string, extra: Record<string, unknown> = {}) =>
  ({ activityType, ...extra });

const slot = (discipline: string): Workout => ({ discipline } as unknown as Workout);

describe('classifyHyroxSessionKind', () => {
  it('uses matched slot discipline for station / brick / run', () => {
    expect(classifyHyroxSessionKind(run('CYCLING'), slot('station'))).toBe('station');
    expect(classifyHyroxSessionKind(run('YOGA'), slot('brick'))).toBe('brick');
    expect(classifyHyroxSessionKind(run('CYCLING'), slot('run'))).toBe('run');
  });

  it('matched-slot discipline overrides raw activity type — strength matched to brick is a brick', () => {
    const strengthActual = { activityType: 'STRENGTH_TRAINING' };
    expect(classifyHyroxSessionKind(strengthActual, slot('brick'))).toBe('brick');
  });

  it('detects strength uploads as station when unmatched', () => {
    expect(classifyHyroxSessionKind({ activityType: 'STRENGTH_TRAINING' }, null)).toBe('station');
  });

  it('classifies running activity types as run when unmatched', () => {
    expect(classifyHyroxSessionKind(run('RUNNING'), null)).toBe('run');
    expect(classifyHyroxSessionKind(run('TRAIL_RUNNING'), null)).toBe('run');
  });

  it('falls back to other for cycling / non-classified sports', () => {
    expect(classifyHyroxSessionKind(run('CYCLING'), null)).toBe('other');
    expect(classifyHyroxSessionKind(run('GENERIC'), null)).toBe('other');
  });

  it('handles missing activityType + null matched slot without throwing', () => {
    expect(classifyHyroxSessionKind({}, null)).toBe('other');
    expect(classifyHyroxSessionKind(null, null)).toBe('other');
  });
});

describe('classifyHyroxActual', () => {
  it('matched station / brick / run carries the canonical label', () => {
    expect(classifyHyroxActual(run('GENERIC'), slot('station'))).toEqual({ kind: 'station', label: 'Station' });
    expect(classifyHyroxActual(run('GENERIC'), slot('brick'))).toEqual({ kind: 'brick', label: 'Brick' });
    expect(classifyHyroxActual(run('GENERIC'), slot('run'))).toEqual({ kind: 'run', label: 'Run' });
  });

  it('unmatched strength upload reads as "Strength" (kind=station)', () => {
    expect(classifyHyroxActual({ activityType: 'STRENGTH_TRAINING' }, null))
      .toEqual({ kind: 'station', label: 'Strength' });
  });

  it('unmatched running activity reads as "Running"', () => {
    expect(classifyHyroxActual(run('RUNNING'), null)).toEqual({ kind: 'run', label: 'Running' });
  });

  it('falls back to formatted activityType for unclassified cross-training', () => {
    expect(classifyHyroxActual(run('CYCLING'), null).kind).toBe('other');
    expect(classifyHyroxActual(run('CYCLING'), null).label).toBe('Cycling');
  });
});

describe('formatActivityType', () => {
  it('title-cases and replaces underscores', () => {
    expect(formatActivityType('TRAIL_RUNNING')).toBe('Trail running');
    expect(formatActivityType('RUNNING')).toBe('Running');
  });

  it('returns "Activity" for empty input', () => {
    expect(formatActivityType('')).toBe('Activity');
  });
});
