/**
 * The HYROX session card shows a lane H2b part 2 station session's parts in
 * muted lines around its station list (warm-up and strength before, the easy
 * erg finisher after) and a load step in one short note.
 */
import { describe, it, expect } from 'vitest';
import { renderHyroxWorkoutCard } from './workout-card';
import { generateHyroxStation, withHyroxSessionParts, withHyroxFinisher, hyroxSessionWarmup } from '@/workouts/hyrox-generators';

const ACCESS = { sled: 'always' as const, skiErg: true, rowErg: true };

describe('HYROX card: a station session\'s parts and load step', () => {
  it('warm-up and strength before the stations, the finisher after, the load step in one note', () => {
    let w = generateHyroxStation({ kind: 'station_technique', targetMinutes: 70, band: 'beginner', stationAccess: ACCESS, phase: 'base', slotIndex: 5 });
    w = withHyroxSessionParts(w, {
      warmup: hyroxSessionWarmup(ACCESS, 5),
      strength: { name: 'Bodyweight Foundation', lines: ['3x10 Bodyweight Squat (Slow) (60s rest)'], min: 20, rpe: 5, eccentric: false },
    });
    w = withHyroxFinisher(w, 12, ACCESS, 5);
    w = { ...w, hyroxSpec: { ...w.hyroxSpec!, loadSteps: [{ station: 'sled_push', fromKg: 50, toKg: 52.5 }] } };
    const html = renderHyroxWorkoutCard(w);
    expect(html).toContain('10 min warm-up, then 20 min strength, then:');
    expect(html).toContain('Then 12 min easy erg.');
    expect(html).toContain('Load up after an easy rating: Sled Push 50 to 52.5 kg.');
    expect(html).not.toMatch(/—/);
    expect(w.estimatedDurationMin).toBeGreaterThanOrEqual(10 + 20 + 12);
  });

  it('a session without parts keeps the plain station list', () => {
    const w = generateHyroxStation({ kind: 'station_technique', targetMinutes: 70, band: 'beginner', stationAccess: ACCESS, phase: 'base', slotIndex: 5 });
    const html = renderHyroxWorkoutCard(w);
    expect(html).not.toContain('warm-up');
    expect(html).not.toContain('easy erg');
  });
});
