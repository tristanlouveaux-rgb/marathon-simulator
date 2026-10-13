// @vitest-environment jsdom
/**
 * Lane H3b: the HYROX screens read the real results (seasons 8 and 9) in the
 * athlete's cohort, and each number on two surfaces comes from one call.
 *  - Stats rank line: "Faster than X% of women aged 30 to 34" (the age table,
 *    pooled S7-S9), the circle and the line from the same placement.
 *  - Forecast station rows and the station detail page: real race-split
 *    percentiles, no "est." label; the radar and the distributions card lead
 *    with the cohort's provenance.
 *  - Station detail history: one frame (one athlete at the target's weights),
 *    labelled once, also when a doubles target has only solo tests.
 *  - Chip detail per-station card: the rows are the forecast's lines, so PR
 *    captions read in the row's frame (the pair's time for doubles), labelled
 *    once; a PR never reads slower than its row.
 *  - Chip detail band thresholds: the field the band seeds are read in.
 *  - Stats circle past a coarse age table's end shows the bound ("<25%").
 *  - Percentile chips read as tiers ("top 27%"), never "pNN".
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

import { getDefaultState, setState } from '@/state/store';
import { predictHyroxRace, hyroxStationHistoryInTargetFrame, hyroxTargetFrameCaption } from '@/calculations/race-prediction.hyrox';
import {
  hyroxCohortPlacement,
  hyroxPlacementHeadline,
  hyroxPlacementFigure,
  hyroxResultsCaption,
  hyroxStationPercentile,
  hyroxBandThresholds,
  hyroxSeedField,
  hyroxFasterThanPct,
} from '@/calculations/hyrox-results';
import { hyroxTierLabel, hyroxTierLabelIn } from '@/calculations/hyrox-population';
import { hyroxOpenSinglesTermsSec } from '@/calculations/hyrox-planning-band';
import { doublesStationSoloSec } from '@/calculations/hyrox-doubles';
import { renderHyroxStatsView, hyroxStatsRank, hyroxBenchmarkLedger, fieldRankMarkerHtml, HYROX_LEDGER_LOAD_NOTE } from './stats-view';
import { renderHyroxStationDetailView } from './station-detail-view';
import { renderPercentileDistributions } from './percentile-distributions';
import { renderPerformanceRadar } from './performance-radar';
import { renderHyroxChipDetail } from './forecast-chip-detail-view';
import { HYROX_STATION_ORDER } from '@/constants/hyrox-benchmarks';
import type { SimulatorState } from '@/types/state';
import type { HyroxStation } from '@/types/triathlon';

const DAY_MS = 1000 * 60 * 60 * 24;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);

const SINGLES: Record<HyroxStation, number> = {
  ski_erg: 300, sled_push: 180, sled_pull: 330, burpee_broad_jumps: 380,
  row_erg: 320, farmer_carry: 135, sandbag_lunges: 300, wall_balls: 400,
};

function hyroxState(hx: Partial<NonNullable<SimulatorState['hyroxConfig']>>, top: Partial<SimulatorState> = {}): SimulatorState {
  const s = getDefaultState();
  s.eventType = 'hyrox' as SimulatorState['eventType'];
  s.w = 1;
  s.wks = [];
  Object.assign(s, top);
  s.hyroxConfig = {
    format: 'open_singles', athleteBand: 'intermediate', hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0, mtlCap: 1000, mtlHistory: [], runsPerWeek: 3,
    stationSessionsPerWeek: 1, bricksPerWeek: 1, weeklyHoursAvailable: 8,
    ...hx,
  } as NonNullable<SimulatorState['hyroxConfig']>;
  return s;
}

const html = () => document.getElementById('app-root')!.innerHTML;

beforeEach(() => {
  document.body.innerHTML = '<div id="app-root"></div>';
});

describe('Stats rank line: the athlete\'s own cohort, age group when known', () => {
  it('a woman aged 32: "of women aged 30 to 34", circle and line from one placement', () => {
    const s = hyroxState({ stationBenchmarksSingles: SINGLES }, { biologicalSex: 'female', onboarding: { ...getDefaultState().onboarding, age: 32 } as SimulatorState['onboarding'] });
    const prediction = predictHyroxRace(s)!;
    const rank = hyroxStatsRank(s, prediction.totalSec)!;
    expect(rank).toEqual(hyroxCohortPlacement(prediction.totalSec, { format: 'open_singles', sex: 'female' }, 32));
    expect(rank.ageGroup).toBe('30-34');
    setState(s);
    renderHyroxStatsView();
    expect(html()).toContain(hyroxPlacementHeadline(rank));
    expect(html()).toMatch(/of women aged 30 to 34/);
    expect(html()).toContain(`${rank.fasterThanPct}%`);
    expect(html()).toContain('Open Singles women');
  });

  it('no sex or age: the format\'s pooled field', () => {
    const s = hyroxState({ stationBenchmarksSingles: SINGLES });
    const rank = hyroxStatsRank(s, predictHyroxRace(s)!.totalSec)!;
    expect(rank.cohort).toEqual({ format: 'open_singles', sex: 'pooled' });
    expect(hyroxPlacementHeadline(rank)).toMatch(/of Open Singles finishers$/);
  });

  it('doubles: the pair\'s division, the athlete\'s own age band with a note', () => {
    const s = hyroxState({ format: 'open_doubles', division: 'mixed', stationBenchmarksSingles: SINGLES }, { biologicalSex: 'male', onboarding: { ...getDefaultState().onboarding, age: 41 } as SimulatorState['onboarding'] });
    const rank = hyroxStatsRank(s, predictHyroxRace(s)!.totalSec)!;
    expect(rank.cohort).toEqual({ format: 'open_doubles', sex: 'mixed' });
    expect(rank.ageGroup).toBe('40-49');
    setState(s);
    renderHyroxStatsView();
    expect(html()).toMatch(/mixed pairs aged 40 to 49/);
    expect(html()).toContain('doubles age groups go by the pair');
  });
});

describe('real station percentiles, no "est." label', () => {
  it('the radar places each line on the cohort\'s race splits and leads with provenance', () => {
    const s = hyroxState({ stationBenchmarksSingles: SINGLES }, { biologicalSex: 'female' });
    const p = predictHyroxRace(s)!;
    const cohort = { format: 'open_singles' as const, sex: 'female' as const };
    const out = renderPerformanceRadar({ stations: p.stations, cohort });
    expect(out).toContain(hyroxResultsCaption(cohort, 'ski_erg'));
    expect(out).not.toMatch(/est\./);
  });

  it('the station detail hero shows the real percentile', () => {
    const s = hyroxState({ stationBenchmarksSingles: SINGLES }, { biologicalSex: 'male' });
    setState(s);
    renderHyroxStationDetailView('wall_balls');
    const pct = hyroxStationPercentile('wall_balls', SINGLES.wall_balls, { format: 'open_singles', sex: 'male' })!;
    expect(html()).toContain(`· ${hyroxTierLabel(pct)}`);
    expect(html()).not.toMatch(/est\. p/);
    expect(html()).not.toMatch(/· p\d/);
  });

  it('the distributions card draws the cohort\'s own tables and says so', () => {
    const s = hyroxState({ format: 'pro_doubles', division: 'women', stationBenchmarksSingles: SINGLES }, { biologicalSex: 'female' });
    setState(s);
    const out = renderPercentileDistributions(predictHyroxRace(s)!);
    expect(out).toContain(hyroxResultsCaption({ format: 'pro_doubles', sex: 'female' }));
    expect(out).not.toMatch(/synthesised|Approximate/);
    expect((out.match(/hx-pd-line/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('the total row names its cohort; the other rows stay short (lane H3c)', () => {
    const cases: Array<[Partial<NonNullable<SimulatorState['hyroxConfig']>>, 'female' | 'male', RegExp]> = [
      [{ format: 'open_singles' }, 'female', / of women$/],
      [{ format: 'open_singles' }, 'male', / of men$/],
      [{ format: 'open_doubles', division: 'mixed' }, 'female', / of mixed pairs$/],
    ];
    for (const [hx, sex, re] of cases) {
      const s = hyroxState({ ...hx, stationBenchmarksSingles: SINGLES }, { biologicalSex: sex });
      setState(s);
      const p = predictHyroxRace(s)!;
      const cohort = hx.format === 'open_doubles' ? { format: 'open_doubles' as const, sex: 'mixed' as const } : { format: 'open_singles' as const, sex };
      const label = hyroxTierLabelIn(hyroxFasterThanPct('total', p.totalSec, cohort)!, cohort);
      expect(label).toMatch(re);
      const out = renderPercentileDistributions(p);
      expect(out).toContain(label);
      const run = hyroxTierLabel(hyroxFasterThanPct('run_total', p.runSec, cohort)!);
      expect(out).toContain(`>${run}</span>`);
    }
  });
});

describe('station detail history: one frame, labelled once', () => {
  it('a doubles race split, a solo test and a Pro-weight test all read as one athlete at Open weights', () => {
    const hist = {
      sled_push: [
        { dateISO: daysAgo(200), sec: 120, source: 'race' as const, format: 'open_doubles' as const, proWeights: false },
        { dateISO: daysAgo(100), sec: 200, source: 'half_test' as const, format: 'open_doubles' as const },
        { dateISO: daysAgo(10), sec: 230, source: 'race' as const, format: 'pro_singles' as const, proWeights: true },
      ],
    };
    const s = hyroxState({ format: 'open_doubles', division: 'women', stationBenchmarksDoubles: { sled_push: 200 }, stationBenchmarkHistory: hist }, { biologicalSex: 'female' });
    const frame = hyroxStationHistoryInTargetFrame(s, 'sled_push');
    expect(frame).toHaveLength(3);
    expect(frame[0].displaySec).toBeCloseTo(doublesStationSoloSec('sled_push', 120, { singles: { format: 'open_singles', sex: 'female' }, doubles: { format: 'open_doubles', sex: 'female' } }), 6);
    expect(frame[0].converted).toBe(true);
    expect(frame[1].displaySec).toBe(200);
    expect(frame[1].converted).toBe(false);
    expect(frame[2].displaySec).toBeLessThan(230); // Pro weights read at Open weights: faster
    setState(s);
    renderHyroxStationDetailView('sled_push');
    const out = html();
    expect(out.split(hyroxTargetFrameCaption(s)).length - 1).toBe(1);
    expect(out).not.toContain('· Pro weights');
  });
});

describe('station detail: a doubles target labels the solo frame even with no conversion', () => {
  it('solo tests only: the hero is the pair\'s time, the cards below say one athlete, once', () => {
    const hist = {
      sled_push: [
        { dateISO: daysAgo(100), sec: 210, source: 'half_test' as const, format: 'open_doubles' as const },
        { dateISO: daysAgo(10), sec: 200, source: 'half_test' as const, format: 'open_doubles' as const },
      ],
    };
    const s = hyroxState({ format: 'open_doubles', division: 'women', stationBenchmarksDoubles: { sled_push: 200 }, stationBenchmarkHistory: hist }, { biologicalSex: 'female' });
    expect(hyroxStationHistoryInTargetFrame(s, 'sled_push').some(e => e.converted)).toBe(false);
    setState(s);
    renderHyroxStationDetailView('sled_push');
    expect(html().split(hyroxTargetFrameCaption(s)).length - 1).toBe(1);
  });

  it('a singles target with nothing converted shows no frame label', () => {
    const s = hyroxState({ stationBenchmarksSingles: { sled_push: 200 },
      stationBenchmarkHistory: { sled_push: [{ dateISO: daysAgo(10), sec: 200, source: 'half_test' as const, format: 'open_singles' as const }] } }, { biologicalSex: 'female' });
    setState(s);
    renderHyroxStationDetailView('sled_push');
    expect(html()).not.toContain(hyroxTargetFrameCaption(s));
  });
});

describe('chip detail per-station card: one frame per card', () => {
  const fmt = (sec: number) => { const t = Math.round(sec); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  it('Open Doubles women, two sled push race splits: the PR reads in the row\'s frame, never slower than the row', () => {
    const hist = {
      sled_push: [
        { dateISO: daysAgo(200), sec: 105, source: 'race' as const, format: 'open_doubles' as const, proWeights: false },
        { dateISO: daysAgo(10), sec: 120, source: 'race' as const, format: 'open_doubles' as const, proWeights: false },
      ],
    };
    const s = hyroxState({ format: 'open_doubles', division: 'women', stationBenchmarksDoubles: { sled_push: 120 }, stationBenchmarkHistory: hist }, { biologicalSex: 'female' });
    const line = predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!;
    expect(line.baseSec).toBeCloseTo(120, 6);
    setState(s);
    renderHyroxChipDetail('stations');
    const out = html();
    const pr = /PR (\d+):(\d{2})/.exec(out);
    expect(pr).not.toBeNull();
    const prSec = Number(pr![1]) * 60 + Number(pr![2]);
    expect(prSec).toBeLessThanOrEqual(Math.round(line.baseSec));
    expect(prSec).toBe(105);
    expect(out).toContain(fmt(line.baseSec));
    // The frame (the pair at the race's weights) is labelled at most once.
    expect(out.split(hyroxTargetFrameCaption(s, 'line')).length - 1).toBe(1);
    expect(out).not.toContain('population averages from the seed table');
  });

  it('a singles target with a doubles race split: PR in solo terms, the label once', () => {
    const hist = {
      sled_push: [
        { dateISO: daysAgo(200), sec: 105, source: 'race' as const, format: 'open_doubles' as const, proWeights: false },
        { dateISO: daysAgo(10), sec: 190, source: 'half_test' as const, format: 'open_singles' as const },
      ],
    };
    const s = hyroxState({ stationBenchmarksSingles: { sled_push: 190 }, stationBenchmarkHistory: hist }, { biologicalSex: 'female' });
    const line = predictHyroxRace(s)!.stations.find(l => l.station === 'sled_push')!;
    const frame = hyroxStationHistoryInTargetFrame(s, 'sled_push');
    expect(frame[0].targetSec).toBeCloseTo(frame[0].displaySec, 9);
    setState(s);
    renderHyroxChipDetail('stations');
    const out = html();
    const best = Math.min(...frame.map(e => e.targetSec));
    expect(best).toBeLessThan(line.baseSec - 0.5);
    expect(out).toContain(`PR ${fmt(best)}`);
    expect(out.split(hyroxTargetFrameCaption(s, 'line')).length - 1).toBe(1);
  });
});

describe('Stats circle past a coarse age table\'s end', () => {
  it('a slow finish in the women 65 to 69 table: the circle shows the bound, matching the headline', () => {
    const slow: Record<HyroxStation, number> = Object.fromEntries(HYROX_STATION_ORDER.map(st => [st, 900])) as Record<HyroxStation, number>;
    const s = hyroxState({ athleteBand: 'total_beginner', stationBenchmarksSingles: slow }, { biologicalSex: 'female', onboarding: { ...getDefaultState().onboarding, age: 67 } as SimulatorState['onboarding'] });
    const rank = hyroxStatsRank(s, predictHyroxRace(s)!.totalSec)!;
    expect(rank.ageGroup).toBe('65-69');
    expect(rank.beyond).toBe('slow');
    const figure = hyroxPlacementFigure(rank);
    expect(figure).toBe(`<${Math.round(100 - rank.tableRange[1])}%`);
    expect(hyroxPlacementHeadline(rank)).toBe(`Slower than ${Math.round(rank.tableRange[1])}% of women aged 65 to 69`);
    setState(s);
    renderHyroxStatsView();
    expect(document.getElementById('app-root')!.textContent).toContain(figure);
    // The bar shows the bound as a bound: a range from the slow end to the
    // bound and a hollow marker there, never a point (lane H3c).
    const root = document.getElementById('app-root')!;
    expect(root.querySelector('[data-hx-rank-marker="point"]')).toBeNull();
    const marker = root.querySelector<HTMLElement>('[data-hx-rank-marker="bound"]')!;
    expect(marker.style.left).toBe(`${100 - rank.tableRange[1]}%`);
    const range = root.querySelector<HTMLElement>('[data-hx-rank-range="slow"]')!;
    expect(range.style.left).toBe('0px');
    expect(range.style.width).toBe(`${100 - rank.tableRange[1]}%`);
  });

  it('the bar marker: a point inside the table, a range to the fast end past it', () => {
    expect(fieldRankMarkerHtml({ fasterThanPct: 62, beyond: null, tableRange: [1, 99] })).toContain('data-hx-rank-marker="point"');
    const fast = fieldRankMarkerHtml({ fasterThanPct: 90, beyond: 'fast', tableRange: [10, 75] });
    expect(fast).toContain('data-hx-rank-range="fast"');
    expect(fast).toContain('left:90%;width:10%');
  });

  it('inside the table the figure is the plain percentage', () => {
    expect(hyroxPlacementFigure({ fasterThanPct: 62, beyond: null, tableRange: [1, 99] })).toBe('62%');
    expect(hyroxPlacementFigure({ fasterThanPct: 75, beyond: 'fast', tableRange: [25, 75] })).toBe('>75%');
  });
});

describe('chip detail band thresholds: the cohort\'s field-relative scale', () => {
  it('a Pro Singles man with an experience band sees the field his seeds are read in', () => {
    const s = hyroxState({ format: 'pro_singles' }, { biologicalSex: 'male' });
    expect(hyroxSeedField(s)).toEqual({ format: 'open_singles', sex: 'male' });
    setState(s);
    renderHyroxChipDetail('you');
    expect(html()).toContain('Open Singles men. Pro and Doubles times convert to Open Singles terms before banding.');
    expect(html()).not.toContain('Pro Singles men.');
  });

  it('a Pro previous time: the caption shows it in Open Singles terms, the time the thresholds band (lane H3c)', () => {
    const s = hyroxState({ format: 'pro_singles', hyroxPreviousTimeFormat: 'pro_singles', previousHyroxTimeSec: 5400 }, { biologicalSex: 'male' });
    setState(s);
    renderHyroxChipDetail('you');
    const open = Math.round(hyroxOpenSinglesTermsSec(5400, 'pro_singles', 'male'));
    const fmt = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    expect(open).toBeLessThan(5400);
    expect(html()).toContain(`Open Singles men. Your 1:30:00 Pro Singles time is ${fmt(open)} in Open Singles terms.`);
  });

  it('a woman sees the women\'s thresholds for the field her band was read in', () => {
    const s = hyroxState({ hyroxPreviousTimeFormat: 'open_singles', previousHyroxTimeSec: 5800 }, { biologicalSex: 'female' });
    setState(s);
    renderHyroxChipDetail('you');
    const th = hyroxBandThresholds({ format: 'open_singles', sex: 'female' });
    const fmt = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    expect(html()).toContain(fmt(th[0].maxSec));
    expect(html()).toContain('Open Singles women. Pro and Doubles times convert to Open Singles terms before banding.');
  });
});

describe('Stats ledger: a row converted to the race\'s weights carries a load note (lane H3c)', () => {
  it('a Mixed Doubles woman\'s Open Singles test reads at M-Open with the note', () => {
    const hist = { sled_push: [{ dateISO: daysAgo(10), sec: 180, source: 'full_test' as const, format: 'open_singles' as const }] };
    const s = hyroxState({ format: 'open_doubles', division: 'mixed', stationBenchmarksSingles: { sled_push: 180 }, stationBenchmarkHistory: hist }, { biologicalSex: 'female' });
    const row = hyroxBenchmarkLedger(s).rows.find(r => r.station === 'sled_push')!;
    expect(row.loadsConverted).toBe(true);
    expect(row.sec!).toBeGreaterThan(180);
    setState(s);
    renderHyroxStatsView();
    expect(html()).toContain(HYROX_LEDGER_LOAD_NOTE);
  });

  it('a Pro target\'s Open test converts; an unloaded station and an own-weight test do not', () => {
    const pro = hyroxState({ format: 'pro_singles', stationBenchmarksSingles: { sled_push: 180, ski_erg: 280 } }, { biologicalSex: 'male' });
    const rows = hyroxBenchmarkLedger(pro).rows;
    expect(rows.find(r => r.station === 'sled_push')!.loadsConverted).toBe(true);
    expect(rows.find(r => r.station === 'ski_erg')!.loadsConverted).toBeUndefined();
    const open = hyroxState({ stationBenchmarksSingles: { sled_push: 180 } }, { biologicalSex: 'male' });
    expect(hyroxBenchmarkLedger(open).rows.find(r => r.station === 'sled_push')!.loadsConverted).toBeUndefined();
    setState(open);
    renderHyroxStatsView();
    expect(html()).not.toContain(HYROX_LEDGER_LOAD_NOTE);
  });
});

describe('every station line has a percentile for every cohort', () => {
  it('no station falls back to a missing table', () => {
    for (const [format, sex] of [['open_singles', 'female'], ['pro_singles', 'male'], ['open_doubles', 'mixed'], ['pro_doubles', 'pooled']] as const) {
      for (const st of HYROX_STATION_ORDER) {
        expect(hyroxStationPercentile(st, 300, { format, sex }), `${format}/${sex}/${st}`).not.toBeNull();
      }
    }
  });
});
