/**
 * HYROX event calendar (hyrox.com/find-my-race, checked 2026-10-12).
 * The calendar used to end on 2026-12-18, so a 16 to 20 week plan started in
 * October could not pick a January to June 2027 race.
 */
import { describe, it, expect } from 'vitest';
import {
  HYROX_WORLD_SERIES,
  getFutureHyroxEvents,
  getHyroxEventById,
  getVenueIdForEvent,
} from './hyrox-events';
import { getHyroxVenueById } from './hyrox-venues';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

describe('HYROX_WORLD_SERIES integrity', () => {
  it('ids are unique and dates are ISO', () => {
    const ids = HYROX_WORLD_SERIES.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of HYROX_WORLD_SERIES) expect(e.date).toMatch(ISO);
  });
  it('verified 2026 and 2027 entries are in date order', () => {
    const verified = HYROX_WORLD_SERIES.filter(e => e.verified);
    for (let i = 1; i < verified.length; i++) {
      expect(verified[i].date >= verified[i - 1].date).toBe(true);
    }
  });
});

describe('2027 calendar', () => {
  it('runs through the June 2027 World Championships in Hong Kong', () => {
    const last = HYROX_WORLD_SERIES.reduce((a, e) => (e.date > a ? e.date : a), '');
    expect(last).toBe('2027-06-10');
    const wc = getHyroxEventById('hong-kong-worldchamps-2027')!;
    expect(wc.city).toBe('Hong Kong');
    expect(wc.verified).toBe(true);
  });
  it('a plan started in October 2026 can pick a January to May 2027 race', () => {
    const future = getFutureHyroxEvents('2026-10-12');
    const months = new Set(future.filter(e => e.date.startsWith('2027-')).map(e => e.date.slice(0, 7)));
    for (const m of ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']) {
      expect(months.has(m)).toBe(true);
    }
  });
  it('confirmed 2027 events are present and verified', () => {
    for (const id of ['manchester-2027', 'amsterdam-2027', 'chicago-2027', 'glasgow-2027', 'paris-2027', 'cologne-2027', 'cardiff-2027']) {
      expect(getHyroxEventById(id)?.verified).toBe(true);
    }
  });
  it('leaves out events not dated on hyrox.com', () => {
    for (const id of ['beijing-2027', 'shanghai-may-2027', 'sao-paulo-2027', 'new-york-2027']) {
      expect(getHyroxEventById(id)).toBeUndefined();
    }
  });
});

describe('late-2026 corrections against hyrox.com', () => {
  it('start dates match the site', () => {
    expect(getHyroxEventById('valencia-oct-2026')!.date).toBe('2026-10-15');
    expect(getHyroxEventById('johannesburg-nov-2026')!.date).toBe('2026-11-26');
    expect(getHyroxEventById('vancouver-2026')!.date).toBe('2026-12-17');
  });
  it('newly dated events are listed', () => {
    for (const id of ['budapest-2026', 'abu-dhabi-2026', 'singapore-2026', 'dubai-2026', 'melbourne-2026', 'stockholm-dec-2026', 'kuala-lumpur-2026']) {
      expect(getHyroxEventById(id)?.verified).toBe(true);
    }
  });
});

describe('venue resolution for 2027 events in a different hall', () => {
  it('Paris 2027 is the Grand Palais, Las Vegas 2027 the LVCC, Guadalajara Expo Guadalajara', () => {
    expect(getVenueIdForEvent('paris-2027')).toBe('paris-grand-palais');
    expect(getVenueIdForEvent('las-vegas-2027')).toBe('vegas-lvcc');
    expect(getVenueIdForEvent('guadalajara-2027')).toBe('guadalajara-expo');
    expect(getHyroxVenueById('guadalajara-expo')!.altitudeM).toBe(1566);
  });
  it('other events keep the city default', () => {
    expect(getVenueIdForEvent('manchester-2027')).toBe('manchester-central');
    expect(getVenueIdForEvent('hong-kong-worldchamps-2027')).toBe('hk-aws');
    expect(getVenueIdForEvent('paris-2026')).toBe('paris-portes');
  });
});
