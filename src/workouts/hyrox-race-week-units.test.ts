/**
 * Units behind the HYROX race-week rules (plan_engine.hyrox raceWeekDays;
 * the plan-level properties are in state/hyrox-race-week.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { generateHyroxStation, raceWeekCircuitStations, MIN_CIRCUIT_STATIONS } from './hyrox-generators';
import { scheduleHyroxWeek, HYROX_TEMPO_HOME_DOW, hyroxPreferredDays } from './scheduler.hyrox';
import { RACE_WEEK_EXCLUDED_STATIONS, ECCENTRIC_HEAVY_STATIONS, STATION_MTL_FACTORS } from '@/constants/hyrox-constants';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { Workout } from '@/types/state';

const FULL = { sled: 'always' as const, skiErg: true, rowErg: true };

describe('race-week station circuit', () => {
  it('the excluded stations are the eccentric-heavy ones and the sleds: every station whose MTL factor is above the farmer carry\'s', () => {
    const above = HYROX_STATION_ORDER.filter(s => STATION_MTL_FACTORS[s].modality * STATION_MTL_FACTORS[s].impact > 1);
    expect([...RACE_WEEK_EXCLUDED_STATIONS].sort()).toEqual(above.sort());
    for (const s of ECCENTRIC_HEAVY_STATIONS) expect(RACE_WEEK_EXCLUDED_STATIONS).toContain(s);
  });

  it('a race-week technique circuit uses no excluded station, for every rotation slot', () => {
    for (let slot = 0; slot < 16; slot++) {
      const w = generateHyroxStation({
        kind: 'station_technique', targetMinutes: 35, band: 'intermediate', stationAccess: FULL,
        phase: 'taper', slotIndex: slot, raceWeek: true,
      });
      const types = (w.hyroxComponents ?? []).map(c => c.type);
      expect(types.length).toBeGreaterThanOrEqual(MIN_CIRCUIT_STATIONS);
      for (const t of types) expect(RACE_WEEK_EXCLUDED_STATIONS as string[]).not.toContain(t);
    }
    // Without the flag the same slot still rotates through every station.
    const all = new Set<string>();
    for (let slot = 0; slot < 8; slot++) {
      const w = generateHyroxStation({ kind: 'station_technique', targetMinutes: 35, band: 'intermediate', stationAccess: FULL, phase: 'taper', slotIndex: slot });
      for (const c of w.hyroxComponents ?? []) all.add(c.type);
    }
    expect(all.has('sled_push')).toBe(true);
  });

  it('without ergs fewer than two circuit stations remain', () => {
    expect(raceWeekCircuitStations({ sled: 'always', skiErg: false, rowErg: false })).toEqual(['farmer_carry']);
    expect(raceWeekCircuitStations(FULL)).toEqual(['ski_erg', 'row_erg', 'farmer_carry']);
  });
});

describe('scheduleHyroxWeek with allowed days', () => {
  const s = (t: string): Workout => ({ n: t, t, d: '', r: 5, rpe: 5 } as Workout);

  it('keeps each session on its allowed days and leaves out what does not fit', () => {
    const out = scheduleHyroxWeek(
      [s('hyrox_run_easy'), s('hyrox_run_tempo'), s('hyrox_run_easy'), s('hyrox_station_technique'), s('hyrox_station_technique')],
      'intermediate',
      (w) => w.t === 'hyrox_run_tempo' ? [0] : w.t === 'hyrox_station_technique' ? [0, 1] : [0, 1, 2],
    );
    // Tempo Monday; one circuit Tuesday; one easy run Wednesday; the rest has no day.
    expect(out.map(w => `${w.dayOfWeek}:${w.t}`)).toEqual(['0:hyrox_run_tempo', '1:hyrox_station_technique', '2:hyrox_run_easy']);
  });

  it('takes the allowed days in the order given: easy runs latest first', () => {
    const out = scheduleHyroxWeek(
      [s('hyrox_run_easy'), s('hyrox_run_easy'), s('hyrox_run_tempo')],
      'intermediate',
      (w) => w.t === 'hyrox_run_tempo' ? [HYROX_TEMPO_HOME_DOW] : [4, 3, 2, 1, 0],
    );
    expect(out.map(w => `${w.dayOfWeek}:${w.t}`)).toEqual(['1:hyrox_run_tempo', '3:hyrox_run_easy', '4:hyrox_run_easy']);
  });

  it('the tempo run\'s home day is Tuesday, its first preferred day', () => {
    expect(HYROX_TEMPO_HOME_DOW).toBe(1);
    expect(hyroxPreferredDays({ t: 'hyrox_run_tempo' })[0]).toBe(HYROX_TEMPO_HOME_DOW);
  });

  it('without allowed days nothing changes (every session placed)', () => {
    const out = scheduleHyroxWeek([s('hyrox_run_easy'), s('hyrox_run_tempo'), s('hyrox_station_technique')], 'intermediate');
    expect(out).toHaveLength(3);
  });
});
