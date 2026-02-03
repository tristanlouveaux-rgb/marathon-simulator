/**
 * Smart Nudging & Honesty Engine — Durability Matrix
 *
 * 4-Case system based on HM-equivalent gap + structural durability.
 * Philosophy: "Honesty over Hype" — never predict a time the user's legs can't support.
 */

import type { RaceDistance } from '@/types';

/** Snapshot of current training state for nudge decisions */
export interface NudgeSnapshot {
  forecastTime: number;          // Predicted race time (seconds)
  milestoneTime: number;         // Target milestone time (seconds)
  milestoneLabel: string;        // e.g. "Sub-3 Hour"
  raceDistance: RaceDistance;
  runsPerWeek: number;
  weeklyKm: number;
  longRunDistanceKm: number;     // Current long run distance
  currentWeek: number;
  totalWeeks: number;
  runnerType: string;
  hmTime?: number;               // Best recent half-marathon time (seconds)
}

/** Nudge case type */
export type NudgeCaseType = 'realistic' | 'conditional' | 'exploratory' | 'none';

/** Nudge decision */
export interface NudgeDecision {
  scenario: NudgeCaseType;
  headline: string;
  detail: string;
  showMilestoneBadge: boolean;
  accentColor: 'emerald' | 'amber' | 'yellow' | 'gray';
}

/** Durability thresholds by distance */
const DURABILITY_THRESHOLDS: Record<RaceDistance, number> = {
  '5k': 10,
  '10k': 14,
  'half': 18,
  'marathon': 28,
};

/**
 * Compute the gap between the runner's equivalent fitness and their target.
 *
 * For marathon: uses HM doubling rule (hmTime * 2 + 600s) if HM data available,
 * otherwise falls back to forecastTime.
 */
function computeGap(snapshot: NudgeSnapshot): number {
  let equivalent: number;

  if (snapshot.raceDistance === 'marathon' && snapshot.hmTime && snapshot.hmTime > 0) {
    // HM doubling rule: double HM + ~10 minutes
    equivalent = snapshot.hmTime * 2 + 600;
  } else {
    equivalent = snapshot.forecastTime;
  }

  return (equivalent - snapshot.milestoneTime) / snapshot.milestoneTime;
}

/**
 * Check durability: has the runner hit the structural long-run threshold?
 */
function isDurable(snapshot: NudgeSnapshot): boolean {
  const threshold = DURABILITY_THRESHOLDS[snapshot.raceDistance] || 28;
  return snapshot.longRunDistanceKm >= threshold;
}

/**
 * Decide which nudge case to show using the Durability Matrix.
 *
 * Case A (Green):  Gap ≤3% AND durable     → Realistic this cycle
 * Case B (Amber):  Gap ≤3% AND !durable    → Fitness is there, durability will decide
 * Case C (Yellow): Gap 3-5%                 → Exploratory — this block will clarify
 * Case D (Red):    Gap >5%                  → Focus on next milestone (hidden)
 */
export function decideMilestone(snapshot: NudgeSnapshot): NudgeDecision {
  const gap = computeGap(snapshot);
  const durable = isDurable(snapshot);

  // Case A: Candidate + Durable
  if (gap <= 0.03 && durable) {
    return {
      scenario: 'realistic',
      headline: `${snapshot.milestoneLabel} — Realistic This Cycle`,
      detail: 'Your HM fitness and long-run structure are aligned. Add marathon-pace work to lock it in.',
      showMilestoneBadge: true,
      accentColor: 'emerald',
    };
  }

  // Case B: Candidate + Not Durable
  if (gap <= 0.03 && !durable) {
    return {
      scenario: 'conditional',
      headline: `${snapshot.milestoneLabel} — Your Engine is Ready`,
      detail: `Your speed supports this target. The challenge now is building leg durability (long run ${snapshot.longRunDistanceKm}km → ${DURABILITY_THRESHOLDS[snapshot.raceDistance]}km+). Accept to shift focus to Endurance.`,
      showMilestoneBadge: true,
      accentColor: 'amber',
    };
  }

  // Case C: Borderline (3-5%)
  if (gap <= 0.05) {
    return {
      scenario: 'exploratory',
      headline: `${snapshot.milestoneLabel} — Under Investigation`,
      detail: 'This training block will clarify whether the target is realistic. Stay consistent.',
      showMilestoneBadge: false,
      accentColor: 'yellow',
    };
  }

  // Case D: Far (>5%) — widget will be hidden by the UI
  return {
    scenario: 'none',
    headline: `Building towards ${snapshot.milestoneLabel}`,
    detail: 'Focus on your next milestone. The speed will come with consistency.',
    showMilestoneBadge: false,
    accentColor: 'gray',
  };
}
