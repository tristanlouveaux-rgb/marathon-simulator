import { describe, it, expect } from 'vitest';
import { applyIllnessModsAllDisciplines } from './illness-rules';
import { applyHolidayModsAllDisciplines, applyBridgeModsAllDisciplines } from '@/ui/holiday-modal';

// Representative multi-discipline week: a run, a tri bike + swim, and a HYROX
// station + brick. The point of these helpers is that NONE of these are skipped
// the way the run-only legacy path skips everything non-run.
function sampleWeek() {
  return {
    run:     { t: 'easy', n: 'Easy Run', d: '8km', r: 3 },
    quality: { t: 'threshold', n: 'Threshold', d: '10km', r: 7 },
    bike:    { t: 'bike_endurance', n: 'Bike', d: '60min', estimatedDurationMin: 60, r: 4 },
    swim:    { t: 'swim_technique', n: 'Swim', d: '30min', estimatedDurationMin: 30, r: 3 },
    station: { t: 'hyrox_station_sled', n: 'Sled Push', d: '40min', estimatedDurationMin: 40, r: 6 },
    brick:   { t: 'hyrox_brick', n: 'Brick', d: '50min', estimatedDurationMin: 50, r: 7 },
  };
}

describe('applyIllnessModsAllDisciplines', () => {
  it('resting marks every sport discipline as rest, not just the run', () => {
    const w = sampleWeek();
    const all = Object.values(w);
    applyIllnessModsAllDisciplines(all, 'resting');
    for (const wo of all) {
      expect(wo.d).toBe('Rest — illness');
      expect((wo as any).illnessMod).toBe(true);
    }
  });

  it('light reduces volume on bike, swim, station and brick (not skipped)', () => {
    const w = sampleWeek();
    applyIllnessModsAllDisciplines([w.bike, w.swim, w.station, w.brick], 'light');
    // 60 * 0.6 = 36 → rounds to 35 (nearest 5)
    expect(w.bike.estimatedDurationMin ?? 0).toBeLessThan(60);
    expect(w.swim.estimatedDurationMin ?? 0).toBeLessThan(30);
    expect(w.station.estimatedDurationMin ?? 0).toBeLessThan(40);
    expect(w.brick.estimatedDurationMin ?? 0).toBeLessThan(50);
    expect((w.bike as any).illnessMod).toBe(true);
  });

  it('light downgrades a quality run to easy', () => {
    const w = sampleWeek();
    applyIllnessModsAllDisciplines([w.quality], 'light');
    expect(w.quality.t).toBe('easy');
  });

  it('leaves rest_like and other workouts alone', () => {
    const yoga = { t: 'yoga', n: 'Yoga', d: 'mobility' };
    const padel = { t: 'padel', n: 'Padel', d: '60min' };
    applyIllnessModsAllDisciplines([yoga, padel], 'resting');
    expect((yoga as any).illnessMod).toBeUndefined();
    expect((padel as any).illnessMod).toBeUndefined();
  });
});

describe('applyHolidayModsAllDisciplines (facility-access model)', () => {
  it('bike always rests, even when running and swimming are on', () => {
    const w = sampleWeek();
    applyHolidayModsAllDisciplines([w.bike], 'yes', null, true);
    expect(w.bike.r).toBe(0);
    expect(w.bike.estimatedDurationMin).toBe(0);
    expect(w.bike.n).toBe('Holiday, bike paused');
    expect((w.bike as any).status).toBe('holiday');
  });

  it('HYROX stations and bricks always rest, even on canRun=yes', () => {
    const w = sampleWeek();
    applyHolidayModsAllDisciplines([w.station, w.brick], 'yes', null, true);
    expect(w.station.estimatedDurationMin).toBe(0);
    expect(w.brick.estimatedDurationMin).toBe(0);
    expect(w.station.r).toBe(0);
    expect(w.station.n).toBe('Holiday, strength paused');
  });

  it('swim rests when canSwim is false', () => {
    const w = sampleWeek();
    applyHolidayModsAllDisciplines([w.swim], 'yes', null, false);
    expect(w.swim.r).toBe(0);
    expect(w.swim.estimatedDurationMin).toBe(0);
    expect(w.swim.n).toBe('Holiday, swim paused');
  });

  it('swim is kept as an easy reduced session when canSwim is true', () => {
    const w = sampleWeek();
    applyHolidayModsAllDisciplines([w.swim], 'yes', null, true);
    expect(w.swim.n).toBe('Easy Swim');
    // 30 * 0.7 = 21 → 20 (nearest 5)
    expect(w.swim.estimatedDurationMin ?? 0).toBeGreaterThan(0);
    expect(w.swim.estimatedDurationMin ?? 0).toBeLessThan(30);
  });

  it('running is the holiday spine: canRun=no rests it, maybe = optional, yes keeps easy runs', () => {
    const no = sampleWeek();
    applyHolidayModsAllDisciplines([no.run], 'no', null, false);
    expect(no.run.r).toBe(0);
    expect(no.run.n).toBe('Holiday, rest day');

    const maybe = sampleWeek();
    applyHolidayModsAllDisciplines([maybe.run], 'maybe', null, false);
    expect(maybe.run.n).toBe('Holiday, optional run');

    const yes = sampleWeek();
    applyHolidayModsAllDisciplines([yes.run], 'yes', null, false);
    // easy run kept (not zeroed) — running is what you can do away
    expect((yes.run as any).holidayMod).toBe(true);
    expect(yes.run.t).toBe('easy');
  });

  it('canRun=yes downgrades a quality run to easy', () => {
    const w = sampleWeek();
    applyHolidayModsAllDisciplines([w.quality], 'yes', null, false);
    expect(w.quality.t).toBe('easy');
    expect(w.quality.n).toBe('Easy Run');
  });

  it('only modifies holiday days when a day set is provided', () => {
    const onDay2 = { t: 'bike_endurance', n: 'Bike', d: '60min', estimatedDurationMin: 60, dayOfWeek: 2, r: 4 };
    const onDay5 = { t: 'bike_endurance', n: 'Bike', d: '60min', estimatedDurationMin: 60, dayOfWeek: 5, r: 4 };
    applyHolidayModsAllDisciplines([onDay2, onDay5], 'no', new Set([2]));
    expect((onDay2 as any).holidayMod).toBe(true);
    expect((onDay5 as any).holidayMod).toBeUndefined();
  });
});

describe('applyBridgeModsAllDisciplines — post-holiday comeback ramp', () => {
  it('scales bike, swim and station volume on the comeback week (not just runs)', () => {
    const w = sampleWeek();
    const all = Object.values(w);
    applyBridgeModsAllDisciplines(all, { _holidayBridgeScale: 0.6 } as any);
    // 60 * 0.6 = 36 → nearest 5 = 35; 30*0.6=18→20; 40*0.6=24→25; 50*0.6=30→30
    expect(w.bike.estimatedDurationMin).toBeLessThan(60);
    expect(w.swim.estimatedDurationMin).toBeLessThan(30);
    expect(w.station.estimatedDurationMin).toBeLessThan(40);
    expect(w.brick.estimatedDurationMin).toBeLessThan(50);
    expect((w.bike as any).status).toBe('reduced');
    expect((w.bike as any).modReason).toBe('Post-holiday bridge');
  });

  it('scales the run km string', () => {
    const w = sampleWeek();
    applyBridgeModsAllDisciplines([w.run], { _holidayBridgeScale: 0.6 } as any);
    // 8 * 0.6 = 4.8 → nearest 0.5 = 5km
    expect(w.run.d).toBe('5km');
    expect((w.run as any).originalDistance).toBe('8km');
  });

  it('downgrades a quality run to easy on a downgrade week', () => {
    const w = sampleWeek();
    applyBridgeModsAllDisciplines([w.quality], { _holidayBridgeScale: 0.6, _holidayBridgeDowngrade: true } as any);
    expect(w.quality.t).toBe('easy');
    expect(w.quality.d).toContain('easy');
  });

  it('is a no-op without a bridge scale', () => {
    const w = sampleWeek();
    const before = JSON.stringify(Object.values(w));
    applyBridgeModsAllDisciplines(Object.values(w), {} as any);
    expect(JSON.stringify(Object.values(w))).toBe(before);
  });

  it('respects an explicit user Adjust and skips adhoc/holiday sessions', () => {
    const userScaled = { t: 'bike_endurance', n: 'Bike', estimatedDurationMin: 60, r: 4, userScaledAt: '2026-06-01' };
    const adhoc = { id: 'adhoc-1', t: 'bike_endurance', n: 'Bike', estimatedDurationMin: 60, r: 4 };
    applyBridgeModsAllDisciplines([userScaled, adhoc], { _holidayBridgeScale: 0.5 } as any);
    expect(userScaled.estimatedDurationMin).toBe(60);
    expect(adhoc.estimatedDurationMin).toBe(60);
  });
});
