import { describe, it, expect } from 'vitest';
import {
  parseKmFromDesc,
  isWeekInHoliday,
  getHolidayDaysForWeek,
  applyHolidayMods,
  applyBridgeMods_renderTime,
} from './holiday-modal';

// ─── parseKmFromDesc ────────────────────────────────────────────────────────

describe('parseKmFromDesc', () => {
  it('parses simple "Nkm" distance', () => {
    expect(parseKmFromDesc('10km')).toBe(10);
  });

  it('parses decimal distances', () => {
    expect(parseKmFromDesc('8.5km easy pace')).toBe(8.5);
  });

  it('sums structured warm-up + main + cool-down', () => {
    expect(parseKmFromDesc('1km warm up\n8km @ threshold\n1km cool down')).toBe(10);
  });

  it('sums multiple km values in a single line', () => {
    expect(parseKmFromDesc('2km warm up + 5km tempo + 2km cool down')).toBe(9);
  });

  it('returns 0 for no km value', () => {
    expect(parseKmFromDesc('30 minutes easy')).toBe(0);
    expect(parseKmFromDesc('')).toBe(0);
  });

  it('handles null/undefined input', () => {
    expect(parseKmFromDesc(null as any)).toBe(0);
    expect(parseKmFromDesc(undefined as any)).toBe(0);
  });
});

// ─── isWeekInHoliday ────────────────────────────────────────────────────────

describe('isWeekInHoliday', () => {
  const planStart = '2026-01-05'; // Monday

  it('returns true when holiday fully covers the week', () => {
    // Week 2 = Jan 12-18
    expect(isWeekInHoliday(2, planStart, { startDate: '2026-01-10', endDate: '2026-01-20' })).toBe(true);
  });

  it('returns true when holiday starts mid-week', () => {
    expect(isWeekInHoliday(2, planStart, { startDate: '2026-01-15', endDate: '2026-01-20' })).toBe(true);
  });

  it('returns true when holiday ends mid-week', () => {
    expect(isWeekInHoliday(2, planStart, { startDate: '2026-01-10', endDate: '2026-01-14' })).toBe(true);
  });

  it('returns false when holiday is before the week', () => {
    expect(isWeekInHoliday(2, planStart, { startDate: '2026-01-01', endDate: '2026-01-04' })).toBe(false);
  });

  it('returns false when holiday is after the week', () => {
    expect(isWeekInHoliday(2, planStart, { startDate: '2026-01-20', endDate: '2026-01-25' })).toBe(false);
  });

  it('returns true when holiday starts on the last day of the week', () => {
    // Week 2 ends Sunday Jan 18
    expect(isWeekInHoliday(2, planStart, { startDate: '2026-01-18', endDate: '2026-01-25' })).toBe(true);
  });
});

// ─── getHolidayDaysForWeek ──────────────────────────────────────────────────

describe('getHolidayDaysForWeek', () => {
  const planStart = '2026-01-05'; // Monday

  it('returns null when entire week is covered', () => {
    // Week 2 = Jan 12-18, holiday covers Jan 10-20
    expect(getHolidayDaysForWeek(2, planStart, { startDate: '2026-01-10', endDate: '2026-01-20' })).toBeNull();
  });

  it('returns correct day indices for partial week', () => {
    // Week 2 = Mon Jan 12 to Sun Jan 18, holiday starts Wed Jan 14
    const days = getHolidayDaysForWeek(2, planStart, { startDate: '2026-01-14', endDate: '2026-01-20' });
    expect(days).not.toBeNull();
    // Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
    expect(days!.has(0)).toBe(false); // Mon
    expect(days!.has(1)).toBe(false); // Tue
    expect(days!.has(2)).toBe(true);  // Wed
    expect(days!.has(3)).toBe(true);  // Thu
    expect(days!.has(4)).toBe(true);  // Fri
    expect(days!.has(5)).toBe(true);  // Sat
    expect(days!.has(6)).toBe(true);  // Sun
  });

  it('returns correct days when holiday ends mid-week', () => {
    // Week 2 = Mon Jan 12 to Sun Jan 18, holiday ends Tue Jan 13
    const days = getHolidayDaysForWeek(2, planStart, { startDate: '2026-01-10', endDate: '2026-01-13' });
    expect(days).not.toBeNull();
    expect(days!.has(0)).toBe(true);  // Mon
    expect(days!.has(1)).toBe(true);  // Tue
    expect(days!.has(2)).toBe(false); // Wed
  });
});

// ─── applyHolidayMods ───────────────────────────────────────────────────────

describe('applyHolidayMods', () => {
  function makeWorkout(overrides: any = {}) {
    return { t: 'easy', n: 'Easy Run', d: '8km easy pace', r: 3, dayOfWeek: 0, ...overrides };
  }

  it('canRun=no: sets all running workouts to rest', () => {
    const workouts = [makeWorkout(), makeWorkout({ t: 'threshold', n: 'Threshold', d: '10km @ threshold' })];
    applyHolidayMods(workouts, 'no');

    for (const w of workouts) {
      expect(w.km).toBe(0);
      expect(w.dur).toBe(0);
      expect(w.status).toBe('holiday');
      expect(w.n).toContain('rest day');
    }
  });

  it('canRun=maybe: sets all running workouts to optional', () => {
    const workouts = [makeWorkout()];
    applyHolidayMods(workouts, 'maybe');
    expect(workouts[0].n).toContain('optional');
    expect(workouts[0].status).toBe('holiday');
  });

  it('canRun=yes: downgrades quality to easy at 70%', () => {
    const workouts = [makeWorkout({ t: 'threshold', n: 'Threshold', d: '10km @ threshold' })];
    applyHolidayMods(workouts, 'yes');
    expect(workouts[0].t).toBe('easy');
    expect(workouts[0].n).toBe('Easy Run');
    expect(workouts[0].km).toBe(7); // 10 * 0.7 = 7
  });

  it('canRun=yes: keeps easy runs unchanged', () => {
    const workouts = [makeWorkout()];
    applyHolidayMods(workouts, 'yes');
    // Easy runs are not quality, so they keep their name
    expect(workouts[0].n).toBe('Easy Run');
    expect(workouts[0].d).toBe('8km easy pace');
  });

  it('skips non-run workouts', () => {
    const workouts = [makeWorkout({ t: 'gym', n: 'Gym Session' })];
    applyHolidayMods(workouts, 'no');
    expect(workouts[0].n).toBe('Gym Session');
    expect((workouts[0] as any).status).toBeUndefined();
  });

  it('only modifies workouts on holiday days when holidayDays provided', () => {
    const workouts = [
      makeWorkout({ dayOfWeek: 0 }), // Mon — not holiday
      makeWorkout({ dayOfWeek: 3 }), // Thu — holiday
    ];
    const holidayDays = new Set([3, 4, 5, 6]);
    applyHolidayMods(workouts, 'no', holidayDays);

    expect((workouts[0] as any).status).toBeUndefined(); // Mon untouched
    expect(workouts[1].status).toBe('holiday'); // Thu modified
  });
});

// ─── applyBridgeMods_renderTime ─────────────────────────────────────────────

describe('applyBridgeMods_renderTime', () => {
  function makeWorkout(overrides: any = {}) {
    return { t: 'easy', n: 'Easy Run', d: '10km easy pace', r: 3, ...overrides };
  }

  it('scales distance by bridge scale factor', () => {
    const workouts = [makeWorkout()];
    const wk = { _holidayBridgeScale: 0.6 } as any;
    applyBridgeMods_renderTime(workouts, wk);
    expect(workouts[0].d).toBe('6km easy pace');
    expect(workouts[0].modReason).toBe('Post-holiday bridge');
  });

  it('downgrades quality to easy when _holidayBridgeDowngrade is true', () => {
    const workouts = [makeWorkout({ t: 'threshold', d: '10km @ threshold' })];
    const wk = { _holidayBridgeScale: 0.6, _holidayBridgeDowngrade: true } as any;
    applyBridgeMods_renderTime(workouts, wk);
    expect(workouts[0].t).toBe('easy');
    expect(workouts[0].d).toContain('easy pace');
  });

  it('does nothing when no bridge scale on week', () => {
    const workouts = [makeWorkout()];
    const wk = {} as any;
    applyBridgeMods_renderTime(workouts, wk);
    expect(workouts[0].d).toBe('10km easy pace');
    expect(workouts[0].modReason).toBeUndefined();
  });

  it('skips workouts already modified by holiday mods', () => {
    const workouts = [makeWorkout({ holidayMod: true })];
    const wk = { _holidayBridgeScale: 0.5 } as any;
    applyBridgeMods_renderTime(workouts, wk);
    expect(workouts[0].d).toBe('10km easy pace'); // unchanged
  });

  it('skips non-run workouts', () => {
    const workouts = [makeWorkout({ t: 'gym', n: 'Gym' })];
    const wk = { _holidayBridgeScale: 0.5 } as any;
    applyBridgeMods_renderTime(workouts, wk);
    expect(workouts[0].d).toBe('10km easy pace'); // unchanged
  });

  it('enforces minimum 2km distance', () => {
    const workouts = [makeWorkout({ d: '3km easy pace' })];
    const wk = { _holidayBridgeScale: 0.3 } as any;
    applyBridgeMods_renderTime(workouts, wk);
    // 3 * 0.3 = 0.9, should clamp to 2
    expect(workouts[0].d).toBe('2km easy pace');
  });
});
