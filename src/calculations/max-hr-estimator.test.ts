import { describe, it, expect } from 'vitest';
import {
  corroboratedMaxHR,
  applyCorroboratedMaxHR,
  MAX_HR_FLOOR_BPM,
  MAX_HR_CEILING_BPM,
} from './max-hr-estimator';

const r = (maxHR: number, date: string) => ({ maxHR, date });

describe('corroboratedMaxHR', () => {
  it('returns the highest reading that has a witness within 5 bpm on a different day', () => {
    // Tristan's real distribution, 2026-06-04: lone 216 spike, 201-203 cluster
    const readings = [
      r(216, '2026-03-13'), // wrist spike — no witness within 5
      r(203, '2026-02-18'),
      r(202, '2025-10-30'),
      r(201, '2026-05-14'),
      r(198, '2026-02-05'),
      r(184, '2026-01-10'),
    ];
    expect(corroboratedMaxHR(readings)).toBe(203);
  });

  it('discards an uncorroborated spike even when it is the only high reading', () => {
    expect(corroboratedMaxHR([
      r(216, '2026-03-13'),
      r(170, '2026-03-10'),
      r(168, '2026-03-08'),
    ])).toBe(170);
  });

  it('same-day readings cannot witness each other (cross-source duplicate twins)', () => {
    // Strava + Garmin webhook rows for the same climb: same value, same day
    expect(corroboratedMaxHR([
      r(203, '2026-02-18'),
      r(203, '2026-02-18'),
    ])).toBe(null);
  });

  it('a witness can sit below the candidate within the window', () => {
    expect(corroboratedMaxHR([r(200, '2026-01-01'), r(196, '2026-01-05')])).toBe(200);
  });

  it('a witness outside the 5 bpm window does not corroborate', () => {
    expect(corroboratedMaxHR([r(200, '2026-01-01'), r(193, '2026-01-05')])).toBe(null);
  });

  it('readings below the hard-effort floor neither define nor witness a max', () => {
    // The historical 144 case: easy sessions agreeing with each other
    expect(corroboratedMaxHR([
      r(144, '2026-01-01'),
      r(144, '2026-01-08'),
      r(130, '2026-01-15'),
    ])).toBe(null);
    expect(MAX_HR_FLOOR_BPM).toBe(150);
  });

  it('readings at or above the plausibility ceiling are discarded', () => {
    expect(corroboratedMaxHR([
      r(MAX_HR_CEILING_BPM, '2026-01-01'),
      r(MAX_HR_CEILING_BPM, '2026-01-08'),
    ])).toBe(null);
  });

  it('returns null for empty, single-reading, and malformed inputs', () => {
    expect(corroboratedMaxHR([])).toBe(null);
    expect(corroboratedMaxHR([r(200, '2026-01-01')])).toBe(null);
    expect(corroboratedMaxHR([r(NaN, '2026-01-01'), r(200, '')])).toBe(null);
  });

  it('accepts full ISO timestamps and compares by calendar day', () => {
    expect(corroboratedMaxHR([
      r(200, '2026-01-01T07:30:00Z'),
      r(199, '2026-01-02T18:00:00+00:00'),
    ])).toBe(200);
    // Same day, different times — still twins
    expect(corroboratedMaxHR([
      r(200, '2026-01-01T07:30:00Z'),
      r(199, '2026-01-01T18:00:00Z'),
    ])).toBe(null);
  });
});

describe('applyCorroboratedMaxHR', () => {
  const cluster = [r(203, '2026-02-18'), r(202, '2025-10-30')];

  it('raises an unset or lower stored value', () => {
    const s: { maxHR?: number } = {};
    expect(applyCorroboratedMaxHR(s, cluster, 'Test')).toEqual({ estimate: 203, changed: true });
    expect(s.maxHR).toBe(203);

    const s2: { maxHR?: number } = { maxHR: 190 };
    expect(applyCorroboratedMaxHR(s2, cluster, 'Test').changed).toBe(true);
    expect(s2.maxHR).toBe(203);
  });

  it('never lowers a higher stored value (ratchet)', () => {
    const s: { maxHR?: number } = { maxHR: 210 };
    expect(applyCorroboratedMaxHR(s, cluster, 'Test')).toEqual({ estimate: 203, changed: false });
    expect(s.maxHR).toBe(210);
  });

  it('no-ops when nothing is corroborated', () => {
    const s: { maxHR?: number } = { maxHR: 201 };
    expect(applyCorroboratedMaxHR(s, [r(216, '2026-03-13')], 'Test')).toEqual({ estimate: null, changed: false });
    expect(s.maxHR).toBe(201);
  });
});
