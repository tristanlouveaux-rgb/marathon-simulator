/**
 * Per-discipline readiness for triathlon — wraps the running-side
 * `computeReadiness` engine, calling it once per discipline using that
 * discipline's own TSB / ACWR / CTL. Sleep + HRV are global, so the recovery
 * sub-score is the same across all three; the difference is in fitness +
 * load-safety sub-scores.
 *
 * Returns a per-discipline `ReadinessResult` plus an overall verdict (the
 * worst label across the three).
 *
 * **Side of the line**: tracking. Pure function over state.
 */

import type { SimulatorState } from '@/types/state';
import type { ReadinessLabel, ReadinessResult } from './readiness';
import { computeReadiness } from './readiness';

export interface TriReadinessResult {
  swim: ReadinessResult;
  bike: ReadinessResult;
  run:  ReadinessResult;
  /** Worst label across the three disciplines — the overall verdict. */
  overall: ReadinessLabel;
  /** Brief one-line summary covering all three. */
  sentence: string;
}

const LABEL_RANK: Record<ReadinessLabel, number> = {
  Primed:        0,
  'On Track':    1,
  'Manage Load': 2,
  'Ease Back':   3,
  Overreaching:  4,
};

export function computeTriReadiness(state: SimulatorState): TriReadinessResult | null {
  const fit = state.triConfig?.fitness;
  if (!fit) return null;

  const physio = state.physiologyHistory ?? [];
  const lastSleep = [...physio].reverse().find(d => d.sleepScore != null);
  const recentHrv = [...physio].reverse().find(d => d.hrvRmssd != null);
  const hrv28d = (() => {
    const window = physio.filter(d => d.hrvRmssd != null).slice(-28);
    if (window.length < 7) return null;
    return window.reduce((s, d) => s + (d.hrvRmssd ?? 0), 0) / window.length;
  })();

  // CTL is stored as weekly EMA; for the readiness engine's "ctlNow" we pass
  // daily-equivalent (÷7) since the running side uses daily CTL.
  const buildInput = (f: { ctl: number; atl: number; tsb: number }) => ({
    tsb: f.tsb / 7,
    acwr: f.ctl > 0 ? f.atl / f.ctl : 1.0,
    ctlNow: f.ctl / 7,
    sleepScore: lastSleep?.sleepScore ?? null,
    sleepHistory: physio,
    hrvRmssd: recentHrv?.hrvRmssd ?? null,
    hrvPersonalAvg: hrv28d,
    weeksOfHistory: state.triConfig?.fitnessHistory?.length ?? 0,
  });

  const swim = computeReadiness(buildInput(fit.swim));
  const bike = computeReadiness(buildInput(fit.bike));
  const run  = computeReadiness(buildInput(fit.run));

  const labels = [swim.label, bike.label, run.label];
  const overall = labels.reduce<ReadinessLabel>((worst, l) =>
    LABEL_RANK[l] > LABEL_RANK[worst] ? l : worst, 'Primed');

  // Compose a one-liner naming the binding discipline + signal.
  const worstDisc = swim.label === overall ? 'swim'
    : bike.label === overall ? 'bike'
    : 'run';
  const worstResult = worstDisc === 'swim' ? swim : worstDisc === 'bike' ? bike : run;
  const sentence = overall === 'On Track' || overall === 'Primed'
    ? worstResult.sentence
    : `${overall}: ${worstDisc} is the binding signal — ${worstResult.sentence.toLowerCase()}`;

  return { swim, bike, run, overall, sentence };
}
