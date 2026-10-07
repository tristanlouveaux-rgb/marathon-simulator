/**
 * Sharpening block: state-side inputs (Tristan 2026-10-05: a marathon under 8
 * weeks away or a half under 4 gets a short plan instead of being refused).
 *
 * The block's rules live in plan_engine (buildSharpeningWeek). This module
 * reads what they need from logged runs:
 *   - the block's first long run, frozen at build (`buildSharpenBlockState`,
 *     stored on s.sharpenBlock), and
 *   - the live reduce-only long-run cap for a week the runner has reached
 *     (`liveSharpeningLongRunCapMin`).
 *
 * Planning side: both prescribe. The 30-day window is Frandsen et al. 2025 (Br
 * J Sports Med, "How much running is too much?"): a single run more than 10%
 * longer than the longest run of the previous 30 days was linked to more
 * overuse injury. The study measured distance, so a logged run counts as its
 * distance in minutes at the plan's easy pace (the currency the plan engine
 * prescribes long runs in), or its duration when no distance was recorded.
 * Race activities count like any run (the study counted every running
 * session); a marathon run 3 weeks earlier therefore sets the next block's
 * start at the ability ceiling (limitation, see SCIENCE_LOG).
 */

import type { SimulatorState, RaceDistance } from '@/types';
import {
  abilityBandFromVdot, clampSharpeningStartMin, sharpeningNoDataStartMin, sharpeningRampPct,
  LONG_SOFT_FLOOR_MIN, planEngineStateInputs,
} from './plan_engine';
import { localDateKey, calendarDayNumber } from '@/utils/local-date';

/** Block formula version stored on s.sharpenBlock.v. */
export const SHARPEN_BLOCK_VERSION = 1;

/** The look-back window for the longest recent run: the 30 days of Frandsen et
 *  al. 2025 (the same study and approval, 2026-10-06, as the plan engine's
 *  LONG_RUN_MAX_GROWTH_VS_RECENT_LONGEST, whose plan-week form is
 *  LONG_RUN_LOOKBACK_WEEKS = 4). */
export const RECENT_LONGEST_WINDOW_DAYS = 30;

const DAY_MS = 86400000;

interface RunLike {
  startTime?: string | null;
  activityType?: string | null;
  distanceKm?: number | null;
  durationSec?: number | null;
}

/** State the logged-run reader traverses. */
export type LoggedRunState = Partial<Pick<SimulatorState, 'wks' | 'previousPlanWks' | 'onboardingRunHistory'>>;

export interface LoggedRun {
  startMs: number;
  km: number | null;
  sec: number | null;
}

function isRunType(t: string | null | undefined): boolean {
  if (!t) return false;
  const u = t.toUpperCase();
  return u === 'RUNNING' || u.includes('RUN');
}

/**
 * Every logged run: the current plan's matched activities, archived plans
 * (previousPlanWks; a plan rebuild archives the weeks it replaces, so the runs
 * of the last 30 days usually sit there at build time) and the onboarding run
 * history, deduplicated by start minute (the same activity can sit in more
 * than one of them).
 */
export function loggedRuns(s: LoggedRunState): LoggedRun[] {
  const byMinute = new Map<number, LoggedRun>();
  const add = (startTime: string | null | undefined, km: number | null | undefined, sec: number | null | undefined) => {
    if (!startTime) return;
    const t = Date.parse(startTime);
    if (!Number.isFinite(t)) return;
    const key = Math.round(t / 60000);
    const run: LoggedRun = {
      startMs: t,
      km: km != null && km > 0 ? km : null,
      sec: sec != null && sec > 0 ? sec : null,
    };
    if (run.km == null && run.sec == null) return;
    const prev = byMinute.get(key);
    // Keep the richer record (a distance beats a duration-only summary).
    if (!prev || (prev.km == null && run.km != null)) byMinute.set(key, run);
  };
  const fromWeeks = (weeks: ReadonlyArray<{ garminActuals?: Record<string, RunLike> } | null | undefined> | undefined) => {
    for (const wk of weeks ?? []) {
      for (const a of Object.values(wk?.garminActuals ?? {})) {
        if (!a || !isRunType(a.activityType)) continue;
        add(a.startTime, a.distanceKm, a.durationSec);
      }
    }
  };
  fromWeeks(s.wks as ReadonlyArray<{ garminActuals?: Record<string, RunLike> }> | undefined);
  for (const plan of s.previousPlanWks ?? []) fromWeeks(plan?.weeks);
  for (const r of s.onboardingRunHistory ?? []) {
    if (!r || !isRunType(r.activityType)) continue;
    add(r.startTime, r.distKm, r.durSec);
  }
  return [...byMinute.values()];
}

/** A logged run as minutes at easy pace (its distance), or its duration. */
export function runEasyMinutes(r: LoggedRun, easyPaceSecPerKm: number): number {
  if (r.km != null && easyPaceSecPerKm > 0) return (r.km * easyPaceSecPerKm) / 60;
  return (r.sec ?? 0) / 60;
}

/** Longest logged run with a start in [fromMs, toMs), minutes at easy pace; null when none. */
export function longestRunMinBetween(
  runs: readonly LoggedRun[], fromMs: number, toMs: number, easyPaceSecPerKm: number,
): number | null {
  let best: number | null = null;
  for (const r of runs) {
    if (r.startMs < fromMs || r.startMs >= toMs) continue;
    const m = runEasyMinutes(r, easyPaceSecPerKm);
    if (m > 0 && (best == null || m > best)) best = m;
  }
  return best;
}

/** State the block build reads. */
export type SharpenBuildState = LoggedRunState
  & Pick<SimulatorState, 'v' | 'pac' | 'onboarding'>;

/**
 * The block's stored inputs, computed at plan build. Start source:
 *   a. a run in the 30 days before build: its distance at easy pace, clamped to
 *      [LONG_SOFT_FLOOR_MIN, ability ceiling];
 *   b. logged runs, none in those 30 days: LONG_SOFT_FLOOR_MIN (the 30-min
 *      restart); the block then uses base-phase session rules;
 *   c. no logged runs: the existing week-1 anchor (marathon 90, half 64 min).
 *      Nothing is known about the runner's longest run here (limitation).
 */
export function buildSharpenBlockState(
  s: SharpenBuildState,
  opts: { raceDistance: RaceDistance; trainingWeeks: number; noSignal: boolean; nowMs?: number },
): NonNullable<SimulatorState['sharpenBlock']> {
  const nowMs = opts.nowMs ?? Date.now();
  const ability = abilityBandFromVdot(s.v || 45, s.onboarding?.experienceLevel || 'intermediate');
  const easyPace = s.pac?.e ?? 360;
  const runs = loggedRuns(s);
  const recent = longestRunMinBetween(runs, nowMs - RECENT_LONGEST_WINDOW_DAYS * DAY_MS, nowMs + 1, easyPace);
  let startSource: NonNullable<SimulatorState['sharpenBlock']>['startSource'];
  let startLongMin: number;
  if (recent != null) {
    startSource = 'history-30d';
    startLongMin = clampSharpeningStartMin(recent, ability, opts.raceDistance);
  } else if (runs.length > 0) {
    startSource = 'history-no-recent-run';
    startLongMin = LONG_SOFT_FLOOR_MIN;
  } else {
    startSource = 'no-data';
    startLongMin = clampSharpeningStartMin(
      sharpeningNoDataStartMin(opts.raceDistance, ability, opts.trainingWeeks), ability, opts.raceDistance,
    );
  }
  return {
    v: SHARPEN_BLOCK_VERSION,
    startLongMin,
    startSource,
    recentLongestMin: recent != null ? Math.round(recent) : null,
    noSignal: opts.noSignal,
    trainingWeeks: opts.trainingWeeks,
    builtISO: localDateKey(new Date(nowMs)),
  };
}

/** State the live long-run cap reads. */
export type LiveCapState = LoggedRunState
  & Pick<SimulatorState, 'w' | 'planStartDate' | 'pac' | 'detectedWeeklyKm' | 'continuousMode' | 'wkm' | 'athleteArchetype'>
  & Partial<Pick<SimulatorState, 'sharpenBlock'>>;

/**
 * Live reduce-only long-run cap for block week `weekIndex` (design 4.3 as
 * amended by its review): (1 + ramp) x the longest run actually logged in the
 * 30 days before that week's Monday, at least LONG_SOFT_FLOOR_MIN. Applies to
 * weeks the runner has reached (weekIndex <= s.w) once at least one run has
 * been logged since the block started, so a skipped or shortened long run
 * holds the next one to the Frandsen bound instead of the planned chain, and a
 * week with no synced runs yet does not trigger it. The window ends at the
 * week's own Monday, so a week's cap never changes while it is current and a
 * past week keeps the cap it had. Future weeks stay on the plan's rows.
 * Undefined when the cap does not apply.
 */
export function liveSharpeningLongRunCapMin(s: LiveCapState, weekIndex: number): number | undefined {
  if (!s.sharpenBlock || !s.planStartDate) return undefined;
  if (!(weekIndex >= 1) || weekIndex > (s.w ?? 1)) return undefined;
  const startDay = calendarDayNumber(s.planStartDate.slice(0, 10));
  if (!Number.isFinite(startDay)) return undefined;
  // Local midnight of the plan's first Monday and of this week's Monday.
  const [y, m, d] = s.planStartDate.slice(0, 10).split('-').map(Number);
  const planStartMs = new Date(y, m - 1, d).getTime();
  const weekStartMs = new Date(y, m - 1, d + (weekIndex - 1) * 7).getTime();
  const runs = loggedRuns(s);
  const sinceStart = runs.some(r => r.startMs >= planStartMs && r.startMs < weekStartMs);
  if (!sinceStart) return undefined;
  const easyPace = s.pac?.e ?? 360;
  const longest = longestRunMinBetween(runs, weekStartMs - RECENT_LONGEST_WINDOW_DAYS * DAY_MS, weekStartMs, easyPace);
  if (longest == null) return undefined;
  const { archetype } = planEngineStateInputs(s);
  return Math.max(LONG_SOFT_FLOOR_MIN, Math.floor(longest * (1 + sharpeningRampPct(archetype))));
}
