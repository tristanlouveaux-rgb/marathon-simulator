// @vitest-environment jsdom
/**
 * "Log a previous HYROX" modal: stored splits belong to the stored result.
 * Logging a different result never stores splits from two races together
 * (review 2026-10-20: a new finish plus one edited station kept seven old
 * stations, the old run legs and the old Roxzone).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/state/persistence', async (orig) => ({
  ...(await orig<typeof import('@/state/persistence')>()),
  saveState: vi.fn(),
}));
vi.mock('@/data/supabaseClient', () => ({
  supabase: { auth: { getUser: async () => ({ data: { user: null } }), getSession: async () => ({ data: { session: null } }) } },
  SUPABASE_URL: 'http://localhost',
  SUPABASE_ANON_KEY: 'test',
  SUPABASE_FUNCTIONS_BASE: undefined,
}));
vi.mock('@/ui/renderer', () => ({ render: () => {}, log: () => {} }));

import type { OnboardingState } from '@/types/onboarding';
import { initializeHyroxSimulator } from '@/state/initialization.hyrox';
import { applyHyroxPrevTimeUpdate } from '@/state/hyrox-prev-time-update';
import { getMutableState, resetState } from '@/state/store';
import { openHyroxLogPrevTimeModal } from './log-prev-time-modal';

const LEGS = [271, 292, 310, 302, 315, 308, 312, 344];
const STATIONS = {
  ski_erg: 287, sled_push: 185, sled_pull: 320, burpee_broad_jumps: 340,
  row_erg: 298, farmer_carry: 125, sandbag_lunges: 301, wall_balls: 390,
} as const;

function init() {
  resetState();
  const ok = initializeHyroxSimulator({
    trainingMode: 'hyrox', hyroxFormat: 'open_singles', experienceLevel: 'intermediate',
    triTimeAvailableHoursPerWeek: 8, pbs: { k10: 2700 },
  } as unknown as OnboardingState).success;
  expect(ok).toBe(true);
  const s = getMutableState();
  s.biologicalSex = 'female';
  applyHyroxPrevTimeUpdate({
    timeSec: 5400, format: 'open_singles', raceDateISO: '2026-03-14',
    stationSplits: { ...STATIONS }, runSplitsSec: LEGS, runTotalSec: 2554, roxzoneSec: 372,
  });
  return s;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
function setTime(v: string) {
  const el = $<HTMLInputElement>('#lpt-time');
  el.value = v;
  el.dispatchEvent(new Event('input'));
}
function setStation(st: string, v: string) {
  const el = $<HTMLInputElement>(`.lpt-split-input[data-station="${st}"]`);
  el.value = v;
  el.dispatchEvent(new Event('change'));
}
const save = () => $<HTMLButtonElement>('#lpt-save').click();

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('a different result never carries the stored result\'s splits', () => {
  it('new finish + one edited station: only that station is stored; runs and Roxzone cleared', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    setTime('1:20:00');
    setStation('wall_balls', '6:00');
    save();
    const hx = s.hyroxConfig!;
    expect(hx.previousHyroxTimeSec).toBe(4800);
    expect(hx.hyroxPreviousStationSplits).toEqual({ wall_balls: 360 });
    expect(hx.hyroxPreviousRunSplitsSec).toBeUndefined();
    expect(hx.hyroxPreviousRunTotalSec).toBeUndefined();
    expect(hx.hyroxPreviousRoxzoneSec).toBeUndefined();
  });

  it('new finish only: the stored splits leave the screen with a note, and nothing old is saved', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    expect($<HTMLInputElement>('.lpt-split-input[data-station="ski_erg"]').value).toBe('4:47');
    setTime('1:20:00');
    expect($<HTMLInputElement>('.lpt-split-input[data-station="ski_erg"]').value).toBe('');
    expect($<HTMLDivElement>('#lpt-splits-note').style.display).toBe('block');
    save();
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toBeUndefined();
    expect(hx.hyroxPreviousRunSplitsSec).toBeUndefined();
    expect(hx.hyroxPreviousRoxzoneSec).toBeUndefined();
  });

  it('a new finish typed then put back: the stored splits return and an untouched save keeps them', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    setTime('1:20:00');
    setTime('1:30:00');
    expect($<HTMLInputElement>('.lpt-split-input[data-station="ski_erg"]').value).toBe('4:47');
    expect($<HTMLDivElement>('#lpt-splits-note').style.display).toBe('none');
    save();
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toEqual(STATIONS);
    expect(hx.hyroxPreviousRunSplitsSec).toEqual(LEGS);
    expect(hx.hyroxPreviousRoxzoneSec).toBe(372);
  });

  it('a different format counts as a different result', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    $<HTMLButtonElement>('[data-fmt="pro_singles"]').click();
    setStation('sled_push', '3:20');
    save();
    expect(s.hyroxConfig!.hyroxPreviousStationSplits).toEqual({ sled_push: 200 });
    expect(s.hyroxConfig!.hyroxPreviousRoxzoneSec).toBeUndefined();
  });
});

describe('the same result', () => {
  it('editing one station keeps the rest, the runs and the Roxzone; only the edit becomes a benchmark', () => {
    const s = init();
    // A SkiErg test after the race is the current benchmark.
    s.hyroxConfig!.stationBenchmarksSingles = { ...s.hyroxConfig!.stationBenchmarksSingles, ski_erg: 270 };
    openHyroxLogPrevTimeModal();
    setStation('wall_balls', '6:00');
    save();
    const hx = s.hyroxConfig!;
    expect(hx.hyroxPreviousStationSplits).toEqual({ ...STATIONS, wall_balls: 360 });
    expect(hx.hyroxPreviousRunSplitsSec).toEqual(LEGS);
    expect(hx.hyroxPreviousRoxzoneSec).toBe(372);
    expect(hx.stationBenchmarksSingles?.wall_balls).toBe(360);
    expect(hx.stationBenchmarksSingles?.ski_erg).toBe(270);
  });
});

describe('division of a doubles result', () => {
  it('the division row shows for doubles formats only and is stored with the result', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    const row = $<HTMLDivElement>('#lpt-division-row');
    expect(row.style.display).toBe('none');
    $<HTMLButtonElement>('[data-fmt="open_doubles"]').click();
    expect(row.style.display).toBe('block');
    $<HTMLButtonElement>('[data-division="mixed"]').click();
    save();
    expect(s.hyroxConfig!.hyroxPreviousTimeFormat).toBe('open_doubles');
    expect(s.hyroxConfig!.hyroxPreviousTimeDivision).toBe('mixed');
  });

  it('a singles athlete picking a doubles format gets the sex-implied division preselected; Mixed is one tap', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    $<HTMLButtonElement>('[data-fmt="open_doubles"]').click();
    const women = $<HTMLButtonElement>('[data-division="women"]');
    expect(women.style.background).toBe('var(--c-black)');
    expect($<HTMLButtonElement>('#lpt-save').disabled).toBe(false);
    save();
    expect(s.hyroxConfig!.hyroxPreviousTimeDivision).toBe('women');
  });

  it('unknown sex: nothing is preselected and Save waits for a division', () => {
    const s = init();
    s.biologicalSex = undefined;
    openHyroxLogPrevTimeModal();
    $<HTMLButtonElement>('[data-fmt="open_doubles"]').click();
    const saveBtn = $<HTMLButtonElement>('#lpt-save');
    expect(saveBtn.disabled).toBe(true);
    $<HTMLButtonElement>('[data-division="mixed"]').click();
    expect(saveBtn.disabled).toBe(false);
    save();
    expect(s.hyroxConfig!.hyroxPreviousTimeDivision).toBe('mixed');
  });

  it('a stored doubles result with no division opens with the sex-implied division shown', () => {
    const s = init();
    s.hyroxConfig!.hyroxPreviousTimeFormat = 'open_doubles';
    s.hyroxConfig!.hyroxPreviousTimeDivision = undefined;
    openHyroxLogPrevTimeModal();
    expect($<HTMLButtonElement>('[data-division="women"]').style.background).toBe('var(--c-black)');
    expect($<HTMLButtonElement>('#lpt-save').disabled).toBe(false);
  });

  it('Pro Doubles has no Mixed; a singles result stores no division', () => {
    const s = init();
    openHyroxLogPrevTimeModal();
    $<HTMLButtonElement>('[data-fmt="open_doubles"]').click();
    $<HTMLButtonElement>('[data-division="mixed"]').click();
    $<HTMLButtonElement>('[data-fmt="pro_doubles"]').click();
    expect($<HTMLButtonElement>('[data-division="mixed"]').style.display).toBe('none');
    $<HTMLButtonElement>('[data-fmt="open_singles"]').click();
    save();
    expect(s.hyroxConfig!.hyroxPreviousTimeDivision).toBeUndefined();
  });
});
