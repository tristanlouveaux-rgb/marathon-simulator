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
 *    labelled once.
 *  - Chip detail band thresholds: the cohort's field-relative thresholds.
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
  hyroxResultsCaption,
  hyroxStationPercentile,
  hyroxBandThresholds,
} from '@/calculations/hyrox-results';
import { doublesStationSoloSec } from '@/calculations/hyrox-doubles';
import { renderHyroxStatsView, hyroxStatsRank } from './stats-view';
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
    const pct = hyroxStationPercentile('wall_balls', SINGLES.wall_balls, { format: 'open_singles', sex: 'male' });
    expect(html()).toContain(`· p${pct}`);
    expect(html()).not.toMatch(/est\. p/);
  });

  it('the distributions card draws the cohort\'s own tables and says so', () => {
    const s = hyroxState({ format: 'pro_doubles', division: 'women', stationBenchmarksSingles: SINGLES }, { biologicalSex: 'female' });
    setState(s);
    const out = renderPercentileDistributions(predictHyroxRace(s)!);
    expect(out).toContain(hyroxResultsCaption({ format: 'pro_doubles', sex: 'female' }));
    expect(out).not.toMatch(/synthesised|Approximate/);
    expect((out.match(/hx-pd-line/g) ?? []).length).toBeGreaterThanOrEqual(4);
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

describe('chip detail band thresholds: the cohort\'s field-relative scale', () => {
  it('a woman sees the women\'s thresholds for the field her band was read in', () => {
    const s = hyroxState({ hyroxPreviousTimeFormat: 'open_singles', previousHyroxTimeSec: 5800 }, { biologicalSex: 'female' });
    setState(s);
    renderHyroxChipDetail('you');
    const th = hyroxBandThresholds({ format: 'open_singles', sex: 'female' });
    const fmt = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    expect(html()).toContain(fmt(th[0].maxSec));
    expect(html()).toContain('Open Singles women. Each band holds the same place in every format and sex field.');
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
