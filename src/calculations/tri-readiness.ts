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
import { buildDailySignalBTSS, computeSleepDebtOutlook, deriveSleepTarget } from './sleep-insights';

export interface TriReadinessResult {
  swim: ReadinessResult;
  bike: ReadinessResult;
  run:  ReadinessResult;
  /** Readiness for cross-training load (non-swim/bike/run). Null when crossTrainingAtl = 0. */
  crossTraining: ReadinessResult | null;
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

  // Sleep debt excess above personal baseline — same signal for all three disciplines
  // (sleep is systemic, not sport-specific).
  const sleepTarget = state.sleepTargetSec ?? deriveSleepTarget(physio);
  const dailyTSS = buildDailySignalBTSS(state.wks ?? [], (state as any).previousPlanWks);
  const debtOutlook = computeSleepDebtOutlook(physio, dailyTSS, state.athleteTier ?? 'recreational', sleepTarget);
  const sleepDebtExcessSec = debtOutlook.typicalDebtSec != null
    ? debtOutlook.debtSec - debtOutlook.typicalDebtSec
    : null;

  // CTL is stored as weekly EMA; for the readiness engine's "ctlNow" we pass
  // daily-equivalent (÷7) since the running side uses daily CTL.
  const buildInput = (f: { ctl: number; atl: number; tsb: number }) => ({
    tsb: f.tsb / 7,
    // Mirror perDisciplineACWR's guard: below CTL 10 the ratio is too noisy to
    // flag overreaching — pass a safe neutral (1.0) instead.
    acwr: f.ctl >= 10 ? f.atl / f.ctl : 1.0,
    ctlNow: f.ctl / 7,
    sleepScore: lastSleep?.sleepScore ?? null,
    sleepHistory: physio,
    hrvRmssd: recentHrv?.hrvRmssd ?? null,
    hrvPersonalAvg: hrv28d,
    sleepDebtExcessSec,
    weeksOfHistory: state.triConfig?.fitnessHistory?.length ?? 0,
  });

  const swim = computeReadiness(buildInput(fit.swim));
  const bike = computeReadiness(buildInput(fit.bike));
  const run  = computeReadiness(buildInput(fit.run));

  // Only disciplines with actual direct activities drive the overall score and
  // sentence. Require directCount > 0 AND CTL ≥ 1 — a single ghost swim from
  // months ago decays to ~0.1 CTL and shouldn't appear in the overall verdict
  // or the coaching sentence.
  const candidates = (
    [
      { disc: 'bike' as const, result: bike, ctl: fit.bike.ctl, directCount: fit.bike.directCount ?? 0 },
      { disc: 'run'  as const, result: run,  ctl: fit.run.ctl,  directCount: fit.run.directCount  ?? 0 },
      { disc: 'swim' as const, result: swim, ctl: fit.swim.ctl, directCount: fit.swim.directCount ?? 0 },
    ] as const
  ).filter(d => d.directCount > 0 && d.ctl >= 1);

  const overall = candidates.length > 0
    ? candidates.reduce<ReadinessLabel>((worst, d) =>
        LABEL_RANK[d.result.label] > LABEL_RANK[worst] ? d.result.label : worst, 'Primed')
    : swim.label;  // fallback: no history at all, use systemic signals

  const worstCandidate = candidates.length > 0
    ? candidates.reduce((worst, d) =>
        LABEL_RANK[d.result.label] >= LABEL_RANK[worst.result.label] ? d : worst)
    : null;

  const crossTrainingAtl = fit.crossTrainingAtl ?? 0;
  const crossTrainingCtl = fit.crossTrainingCtl ?? 0;

  const crossTraining: ReadinessResult | null = crossTrainingAtl > 0
    ? computeReadiness(buildInput({ ctl: crossTrainingCtl, atl: crossTrainingAtl, tsb: crossTrainingCtl - crossTrainingAtl }))
    : null;

  const sentence = (() => {
    if (!worstCandidate || overall === 'On Track' || overall === 'Primed') {
      return worstCandidate?.result.sentence ?? 'All disciplines are clear.';
    }
    const cap = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
    const others = candidates
      .filter(d => d.disc !== worstCandidate.disc)
      .map(d => cap(d.disc)).join(' and ');
    // "clear" would contradict the UI cap — say "not the primary concern" instead.
    const othersClause = others
      ? ` ${others} ${others.includes(' and ') ? 'are' : 'is'} not the primary concern.`
      : '';

    // Detect cross-training as primary load driver by comparing its ATL to the
    // highest single-discipline ATL among active candidates.
    const maxDisciplineAtl = Math.max(...candidates.map(d => {
      if (d.disc === 'bike') return fit.bike.atl;
      if (d.disc === 'run') return fit.run.atl;
      return fit.swim.atl;
    }), 0);
    // Only treat cross-training as a load "cause" when it is both the largest
    // source AND its own readiness is stressed (Manage Load or worse). If
    // cross-training ACWR is fine (Clear/On Track), high volume is normal
    // baseline for this athlete — don't blame it for discipline overreaching.
    const crossIsStressed = crossTraining != null
      && LABEL_RANK[crossTraining.label] >= LABEL_RANK['Manage Load'];
    const crossIsDominant = crossTrainingAtl > 0 && crossTrainingAtl > maxDisciplineAtl && crossIsStressed;
    const crossIsSignificant = crossTrainingAtl > 0 && crossTrainingAtl > maxDisciplineAtl * 0.5 && crossIsStressed;

    if (overall === 'Overreaching') {
      if (crossIsDominant) {
        return `Cross-training has pushed your load above baseline. Planned sessions can continue. Reduce discretionary activities this week.`;
      }
      if (crossIsSignificant) {
        return `${cap(worstCandidate.disc)} load is elevated relative to your baseline, with cross-training adding to the total. Reduce ${worstCandidate.disc} volume and limit extra activities this week.`;
      }
      return `${cap(worstCandidate.disc)} load is high relative to your baseline. Reduce ${worstCandidate.disc} volume this week.${othersClause}`;
    }
    if (overall === 'Ease Back') {
      if (crossIsDominant) {
        return `Cross-training has added significant load this week. Reduce volume across all activities.`;
      }
      return `${cap(worstCandidate.disc)} needs more recovery.${others ? ` ${others} ${others.includes(' and ') ? 'are' : 'is'} fine today.` : ''}`;
    }
    return `${cap(worstCandidate.disc)} load is elevated.${othersClause}`;
  })();

  return { swim, bike, run, crossTraining, overall, sentence };
}
