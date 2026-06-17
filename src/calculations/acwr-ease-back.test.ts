import { describe, it, expect } from 'vitest';
import { computeAcwrEaseBack, intentTSS, resolveAcwrEpisodeChoice } from './acwr-ease-back';
import type { SessionIntent } from '@/workouts/intent_to_workout';

const SAFE_UPPER = 1.4;
const EASY_FLOOR = 25;
const LONG_FLOOR = 30;

function intent(p: Partial<SessionIntent> & Pick<SessionIntent, 'slot'>): SessionIntent {
  return {
    dayIndex: 0,
    totalMinutes: p.totalMinutes ?? 50,
    workMinutes: p.workMinutes ?? (p.totalMinutes ?? 50),
    variantId: p.variantId ?? `${p.slot}_steady`,
    notes: '',
    ...p,
  };
}

/** A representative quality-heavy week. */
function week(): SessionIntent[] {
  return [
    intent({ slot: 'long', totalMinutes: 120, workMinutes: 120, variantId: 'long_steady' }),
    intent({ slot: 'threshold', totalMinutes: 55, workMinutes: 24 }),
    intent({ slot: 'vo2', totalMinutes: 50, workMinutes: 20 }),
    intent({ slot: 'easy', totalMinutes: 60 }),
    intent({ slot: 'easy', totalMinutes: 45 }),
  ];
}

const weekTSS = (is: SessionIntent[]) => is.reduce((s, i) => s + intentTSS(i), 0);
/** chronic that yields L_max = fraction × standardTSS. */
const chronicFor = (std: number, fraction: number) => (std * fraction) / SAFE_UPPER;
const opts = (chronicWeeklyTSS: number) => ({
  chronicWeeklyTSS, safeUpper: SAFE_UPPER, easyFloorMin: EASY_FLOOR, longFloorMin: LONG_FLOOR,
});

describe('computeAcwrEaseBack', () => {
  it('no-ops when the week is already at or under L_max', () => {
    const w = week();
    const std = weekTSS(w);
    const r = computeAcwrEaseBack(w, opts(chronicFor(std, 1.2))); // ceiling above the week
    expect(r.shedTSS).toBe(0);
    expect(r.steps).toHaveLength(0);
    expect(r.intents).toEqual(w);
  });

  it('never mutates the input intents', () => {
    const w = week();
    const snapshot = JSON.parse(JSON.stringify(w));
    computeAcwrEaseBack(w, opts(chronicFor(weekTSS(w), 0.5)));
    expect(w).toEqual(snapshot);
  });

  it('strips intensity before trimming volume, preserving all distances (mild overshoot)', () => {
    const w = week();
    const std = weekTSS(w);
    // ceiling just below standard → a quality downgrade or two should suffice
    const r = computeAcwrEaseBack(w, opts(chronicFor(std, 0.9)));

    // Total minutes (distance) unchanged at a mild overshoot — only intensity stripped.
    const totalMins = (is: SessionIntent[]) => is.reduce((s, i) => s + i.totalMinutes, 0);
    expect(totalMins(r.intents)).toBe(totalMins(w));
    // At least one quality session became easy.
    const qualityRemaining = r.intents.filter(i => ['threshold', 'vo2', 'marathon_pace', 'progressive', 'float'].includes(i.slot));
    expect(qualityRemaining.length).toBeLessThan(2);
    // Long run distance untouched.
    expect(r.intents.find(i => i.slot === 'long')!.totalMinutes).toBe(120);
    expect(r.adjustedTSS).toBeLessThanOrEqual(r.lMax + 0.01);
  });

  it('protects the long-run distance until intensity + easy volume are exhausted', () => {
    const w = week();
    const std = weekTSS(w);
    // Deep overshoot → forces the full ladder including a long-run trim.
    const r = computeAcwrEaseBack(w, opts(chronicFor(std, 0.4)));

    // All quality stripped to easy.
    const qualityRemaining = r.intents.filter(i => ['threshold', 'vo2', 'marathon_pace', 'progressive', 'float'].includes(i.slot));
    expect(qualityRemaining).toHaveLength(0);
    // No easy run trimmed below its floor.
    const easies = r.intents.filter(i => i.slot === 'easy');
    expect(easies.every(e => e.totalMinutes >= EASY_FLOOR)).toBe(true);
    // Long run shortened only as a last resort, and never below its floor.
    const long = r.intents.find(i => i.slot === 'long')!;
    expect(long.totalMinutes).toBeLessThan(120);
    expect(long.totalMinutes).toBeGreaterThanOrEqual(LONG_FLOOR);
    expect(r.steps.some(s => /Long run shortened/.test(s))).toBe(true);
  });

  it('downgrades a fast-finish long run to steady when easing back', () => {
    const w = week();
    w[0] = intent({ slot: 'long', totalMinutes: 120, workMinutes: 120, variantId: 'long_fast_finish' });
    const r = computeAcwrEaseBack(w, opts(chronicFor(weekTSS(w), 0.9)));
    const long = r.intents.find(i => i.slot === 'long')!;
    expect(long.variantId).toBe('long_steady');
    expect(r.steps.some(s => /steady pace/.test(s))).toBe(true);
  });

  it('keeps work minutes equal to total minutes on converted easy sessions', () => {
    const w = week();
    const r = computeAcwrEaseBack(w, opts(chronicFor(weekTSS(w), 0.5)));
    const converted = r.intents.filter(i => i.variantId === 'easy_steady');
    expect(converted.length).toBeGreaterThan(0);
    converted.forEach(c => expect(c.workMinutes).toBe(c.totalMinutes));
  });
});

describe('resolveAcwrEpisodeChoice (escalation)', () => {
  it('carries a prior keep choice forward at mild high (no re-nag)', () => {
    const d = resolveAcwrEpisodeChoice(['high'], 1.45, 'keep');
    expect(d.acwrChoice).toBe('keep');
    expect(d.forceReprompt).toBe(false);
    expect(d.consecutiveHigh).toBe(2); // prior high + the upcoming high
  });

  it('clears the choice at very high (ratio ≥ 1.6) so the safe default returns', () => {
    const d = resolveAcwrEpisodeChoice(['high'], 1.6, 'keep');
    expect(d.acwrChoice).toBeUndefined();
    expect(d.forceReprompt).toBe(true);
  });

  it('clears the choice on the 3rd consecutive high week even at mild ratio', () => {
    const d = resolveAcwrEpisodeChoice(['high', 'high'], 1.42, 'keep'); // upcoming = 3rd high
    expect(d.consecutiveHigh).toBe(3);
    expect(d.forceReprompt).toBe(true);
    expect(d.acwrChoice).toBeUndefined();
  });

  it('leaves the choice unset for a fresh high week (new episode)', () => {
    const d = resolveAcwrEpisodeChoice(['safe', 'safe'], 1.4, undefined);
    expect(d.acwrChoice).toBeUndefined();
    expect(d.consecutiveHigh).toBe(1);
    expect(d.forceReprompt).toBe(false);
  });

  it('stops the streak count at the first non-high week', () => {
    const d = resolveAcwrEpisodeChoice(['high', 'safe', 'high'], 1.4, 'keep');
    expect(d.consecutiveHigh).toBe(2); // upcoming + the immediately-prior high; the 'safe' breaks it
    expect(d.acwrChoice).toBe('keep'); // still within carry window (< 3, < 1.6)
  });
});
