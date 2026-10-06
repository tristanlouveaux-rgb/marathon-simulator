/**
 * The AI coach plan skeleton prices HYROX weeks with the canonical planned-day
 * pricer (cross-mode audit f4).
 *
 * buildPlanSkeleton's tri / HYROX branch summed w.aerobic + w.anaerobic. HYROX
 * generators stamp neither (sessions carry musculoTendonLoad), so planned_tss
 * read 0 for every HYROX week while the Home strain ring priced the same week
 * through getPlannedDayTSSContext. Latent while AI_COACH_ENABLED is false.
 *
 * Real HYROX generator, real buildPlanSkeleton, real getPlannedDayTSSContext.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildPlanSkeleton } from '../coach-context-builder';
import { getPlannedDayTSSContext } from '@/ui/planned-day-tss';
import { generateHyroxPlan, HYROX_GENERATOR_VERSION } from '@/workouts/plan_engine.hyrox';
import { HYROX_WEEKLY_SESSIONS, HYROX_MTL_CAP, HYROX_HOURS_RANGE } from '@/constants/hyrox-constants';
import { getDefaultState } from '@/state/store';
import type { SimulatorState } from '@/types/state';

function hyroxState(): SimulatorState {
  const band = 'intermediate' as const;
  const s = getDefaultState();
  s.eventType = 'hyrox';
  s.trackOnly = false;
  s.planStartDate = '2026-09-28';
  s.w = 3;
  s.tw = 16;
  s.hyroxConfig = {
    format: 'open_singles',
    athleteBand: band,
    hyroxPhase: 'base',
    stationAccess: { sled: 'always', skiErg: true, rowErg: true },
    weeklyMTL: 0,
    mtlCap: HYROX_MTL_CAP[band],
    mtlHistory: [],
    runsPerWeek: HYROX_WEEKLY_SESSIONS[band].runs,
    stationSessionsPerWeek: HYROX_WEEKLY_SESSIONS[band].stations,
    bricksPerWeek: HYROX_WEEKLY_SESSIONS[band].bricks,
    weeklyHoursAvailable: HYROX_HOURS_RANGE[band].default,
    generatorVersion: HYROX_GENERATOR_VERSION,
  };
  s.wks = generateHyroxPlan(s);
  return s;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('buildPlanSkeleton: HYROX planned_tss matches the planned-day pricer', () => {
  it('every week of a real 16-week plan carries the Home ring\'s planned week TSS', () => {
    const s = hyroxState();
    // The generator stamps no aerobic / anaerobic load on HYROX sessions.
    expect(s.wks.every(wk => (wk.triWorkouts ?? []).every(w => !w.aerobic && !w.anaerobic))).toBe(true);

    const skeleton = buildPlanSkeleton(s);
    expect(skeleton).toHaveLength(16);
    skeleton.forEach((row, i) => {
      const ring = getPlannedDayTSSContext(s, i + 1).plannedWeekTSS;
      expect(ring).toBeGreaterThan(0);
      expect(row.planned_tss).toBe(ring); // was 0
    });
  }, 20000);
});
