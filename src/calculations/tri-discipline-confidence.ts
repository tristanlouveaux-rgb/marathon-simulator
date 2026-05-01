/**
 * Per-discipline data confidence — drives the captions under each
 * Fitness/Fatigue/Form row so users know what's behind the number.
 *
 * **Side of the line**: tracking. Pure function over `state.wks`.
 *
 * Returns, per discipline:
 *   - `weeksActive` — number of distinct weeks (in last 12) with at least one
 *     activity of that discipline.
 *   - `sessions`    — total session count of that discipline in the same window.
 *   - `confidence`  — 'high' (≥6 weeks active), 'medium' (3–5), 'low' (1–2),
 *                     'none' (0).
 *
 * The CTL/ATL/TSB values themselves are always real — but their *interpretation*
 * depends on how much data backs them. Show a low-confidence athlete a muted
 * caption like "Limited swim history — build a few more weeks for a stable
 * baseline"; show a high-confidence athlete the proud caption "Based on 11
 * weeks of bike training (38 rides)".
 */

import type { SimulatorState } from '@/types/state';
import type { Discipline } from '@/types/triathlon';
import { classifyActivity } from './tri-benchmarks-from-history';

export interface DisciplineConfidence {
  weeksActive: number;
  sessions: number;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export type TriDisciplineConfidence = Record<Discipline, DisciplineConfidence>;

export function computeTriDisciplineConfidence(
  state: SimulatorState,
  weeks: number = 12,
): TriDisciplineConfidence {
  const out: TriDisciplineConfidence = {
    swim: empty(),
    bike: empty(),
    run:  empty(),
  };

  // Primary source: `triConfig.fitnessHistory` is backfilled at launch via
  // `deriveTriBenchmarksFromHistory(loadActivitiesFromDB())`, so it sees the
  // user's full Strava/Garmin history regardless of whether `state.wks[w].
  // garminActuals` has been populated. Each entry has per-discipline CTL —
  // a non-zero CTL implies activity that week for that discipline.
  const history = state.triConfig?.fitnessHistory ?? [];
  const recentHistory = history.slice(-weeks);
  if (recentHistory.length > 0) {
    for (const h of recentHistory) {
      if (h.swimCtl > 0) out.swim.weeksActive += 1;
      if (h.bikeCtl > 0) out.bike.weeksActive += 1;
      if (h.runCtl  > 0) out.run.weeksActive  += 1;
    }
    // Session counts aren't stored on fitnessHistory; fall back to
    // garminActuals scan for an approximate count, otherwise 0.
    const wks = state.wks ?? [];
    const currentWeek = state.w ?? 0;
    const startWeek = Math.max(0, currentWeek - weeks + 1);
    for (let w = startWeek; w <= currentWeek; w++) {
      const wk = wks[w];
      if (!wk?.garminActuals) continue;
      for (const actual of Object.values(wk.garminActuals)) {
        const sport = classifyActivity(actual?.activityType);
        if (sport === 'other') continue;
        out[sport].sessions += 1;
      }
    }
    for (const d of ['swim', 'bike', 'run'] as Discipline[]) {
      out[d].confidence = bucketConfidence(out[d].weeksActive);
    }
    return out;
  }

  // Fallback: no fitnessHistory yet — count from state.wks directly.
  const wks = state.wks ?? [];
  const currentWeek = state.w ?? 0;
  const startWeek = Math.max(0, currentWeek - weeks + 1);
  const activeWeeks: Record<Discipline, Set<number>> = {
    swim: new Set(), bike: new Set(), run: new Set(),
  };
  for (let w = startWeek; w <= currentWeek; w++) {
    const wk = wks[w];
    if (!wk?.garminActuals) continue;
    for (const actual of Object.values(wk.garminActuals)) {
      const sport = classifyActivity(actual?.activityType);
      if (sport === 'other') continue;
      out[sport].sessions += 1;
      activeWeeks[sport].add(w);
    }
  }
  for (const d of ['swim', 'bike', 'run'] as Discipline[]) {
    out[d].weeksActive = activeWeeks[d].size;
    out[d].confidence = bucketConfidence(out[d].weeksActive);
  }
  return out;
}

function empty(): DisciplineConfidence {
  return { weeksActive: 0, sessions: 0, confidence: 'none' };
}

function bucketConfidence(weeksActive: number): DisciplineConfidence['confidence'] {
  if (weeksActive >= 6) return 'high';
  if (weeksActive >= 3) return 'medium';
  if (weeksActive >= 1) return 'low';
  return 'none';
}
