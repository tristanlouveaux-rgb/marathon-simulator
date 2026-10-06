/**
 * Per-discipline readiness for triathlon. Wraps the running-side
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
import type { Workout } from '@/types/state';
import type { ReadinessLabel, ReadinessResult } from './readiness';
import { computeReadiness } from './readiness';
import { isImpactBlockedByInjury } from '@/injury/engine';
import { buildDailySignalBTSS, computeSleepDebtOutlook, deriveSleepTarget, mergeManualSleepHistory } from './sleep-insights';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const QUALITY_KEYWORDS = ['threshold', 'vo2', 'tempo', 'sweet_spot', 'sweetspot', 'speed', 'race_pace', 'intervals', 'hills', 'brick'];

function isQuality(w: Workout): boolean {
  const t = (w.t ?? '').toLowerCase();
  return QUALITY_KEYWORDS.some(k => t.includes(k)) || (w.rpe ?? w.r ?? 0) >= 7;
}

/**
 * Returns the next hard session (quality workout or RPE≥7) scheduled in the
 * upcoming `lookaheadDays` window, looking across the current and next week's
 * `triWorkouts`. Excludes completed/skipped/replaced workouts.
 */
export function findUpcomingHardSession(state: SimulatorState, lookaheadDays: number): { dayLabel: string; workout: Workout } | null {
  const wks = state.wks ?? [];
  // s.w is 1-based (store.ts default w: 1): the current week is wks[s.w - 1].
  const curIdx = (state.w ?? 1) - 1;
  const cur = wks[curIdx]?.triWorkouts ?? [];
  const next = wks[curIdx + 1]?.triWorkouts ?? [];
  const todayDow = (new Date().getDay() + 6) % 7;
  const isActive = (w: Workout) => w.status !== 'completed' && w.status !== 'skipped' && w.status !== 'replaced';

  for (let offset = 1; offset <= lookaheadDays; offset++) {
    const targetDow = (todayDow + offset) % 7;
    const wrapsToNextWeek = todayDow + offset > 6;
    const pool = wrapsToNextWeek ? next : cur;
    const hit = pool.find(w => w.dayOfWeek === targetDow && isActive(w) && isQuality(w));
    if (hit) return { dayLabel: DAY_NAMES[targetDow], workout: hit };
  }
  return null;
}

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

  // Fold manual sleep (recoveryHistory) in so a no-watch tri athlete's check-in
  // night reaches the per-discipline readiness engine. Mirrors running mode
  // (daily-coach / home-view). Device sleep wins per date; HRV / duration reads
  // are unaffected (manual entries carry only a sleepScore).
  const physio = mergeManualSleepHistory(state.physiologyHistory ?? [], state.recoveryHistory ?? []);
  const lastSleep = [...physio].reverse().find(d => d.sleepScore != null);
  const recentHrv = [...physio].reverse().find(d => d.hrvRmssd != null);
  const hrv28d = (() => {
    const window = physio.filter(d => d.hrvRmssd != null).slice(-28);
    if (window.length < 7) return null;
    return window.reduce((s, d) => s + (d.hrvRmssd ?? 0), 0) / window.length;
  })();

  // Sleep debt excess above personal baseline. Same signal for all three disciplines
  // (sleep is systemic, not sport-specific).
  const sleepTarget = state.sleepTargetSec ?? deriveSleepTarget(physio);
  const dailyTSS = buildDailySignalBTSS(state.wks ?? [], (state as any).previousPlanWks);
  const debtOutlook = computeSleepDebtOutlook(physio, dailyTSS, state.athleteTier ?? 'recreational', sleepTarget);
  const sleepDebtExcessSec = debtOutlook.typicalDebtSec != null
    ? debtOutlook.debtSec - debtOutlook.typicalDebtSec
    : null;

  const upcomingHardSession = findUpcomingHardSession(state, 2);
  const upcomingHardForInput = upcomingHardSession != null;

  // CTL is stored as weekly EMA; for the readiness engine's "ctlNow" we pass
  // daily-equivalent (÷7) since the running side uses daily CTL.
  // Leg load (eccentric/footstrike fatigue from runs, bricks, gym leg days, and
  // cross-training) gates the RUN discipline only: the floor models impact risk,
  // which is a running concern. Swim is non-impact; cycling tolerates tired legs.
  // So only the run input carries recentLegLoads — bike/swim/cross-training stay
  // honest. Mirrors running mode exactly (same floor, same ledger).
  const buildInput = (f: { ctl: number; atl: number; tsb: number }, withLegLoad = false) => ({
    tsb: f.tsb / 7,
    // Mirror perDisciplineACWR's guard: below CTL 10 the ratio is too noisy to
    // flag overreaching. Pass a safe neutral (1.0) instead.
    acwr: f.ctl >= 10 ? f.atl / f.ctl : 1.0,
    ctlNow: f.ctl / 7,
    sleepScore: lastSleep?.sleepScore ?? null,
    sleepHistory: physio,
    hrvRmssd: recentHrv?.hrvRmssd ?? null,
    hrvPersonalAvg: hrv28d,
    sleepDebtExcessSec,
    weeksOfHistory: state.triConfig?.fitnessHistory?.length ?? 0,
    hasUpcomingHardSession: upcomingHardForInput,
    recentLegLoads: withLegLoad ? (state.recentLegLoads ?? []) : undefined,
    // Run is blocked by injury → the leg-load floor (impact risk) is moot. Only
    // the run input carries leg load, so this mirrors that gating exactly.
    impactBlocked: withLegLoad ? isImpactBlockedByInjury(state.injuryState) : undefined,
  });

  const swim = computeReadiness(buildInput(fit.swim));
  const bike = computeReadiness(buildInput(fit.bike));
  const run  = computeReadiness(buildInput(fit.run, true));

  // Only disciplines with actual direct activities drive the overall score and
  // sentence. Require directCount > 0 AND CTL ≥ 1. A single ghost swim from
  // months ago decays to ~0.1 CTL and shouldn't appear in the overall verdict
  // or the coaching sentence.
  //
  // Also exclude disciplines the user has explicitly gated as 'no' on the
  // active injury. Without this, a tri user who blocked swim for weeks would
  // see their decayed swim CTL drag the overall verdict toward "Ease Back"
  // even though their bike + run training is on track. The verdict should
  // reflect only what the athlete can actually do.
  const inj = state.injuryState;
  const isGatedOut = (disc: 'swim' | 'bike' | 'run'): boolean => {
    if (!inj?.active) return false;
    if (disc === 'swim') return inj.canSwim === 'no';
    if (disc === 'bike') return inj.canBike === 'no';
    if (disc === 'run')  return inj.canRun === 'no';
    return false;
  };
  const candidates = (
    [
      { disc: 'bike' as const, result: bike, ctl: fit.bike.ctl, directCount: fit.bike.directCount ?? 0 },
      { disc: 'run'  as const, result: run,  ctl: fit.run.ctl,  directCount: fit.run.directCount  ?? 0 },
      { disc: 'swim' as const, result: swim, ctl: fit.swim.ctl, directCount: fit.swim.directCount ?? 0 },
    ] as const
  ).filter(d => d.directCount > 0 && d.ctl >= 1 && !isGatedOut(d.disc));

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

  // Which disciplines are restricted by an active injury? Used to suppress
  // misleading "X is not the primary concern" clauses (which would imply X is
  // available) and to reframe the load story when the flagged discipline is
  // itself the one being rehabbed. The injury chip on the Readiness card
  // already tells the user injury is active, so the sentence no longer needs
  // an "Injury is active …" appendix.
  const injuryRestricted = (() => {
    if (!inj?.active) return new Set<'run' | 'bike' | 'swim'>();
    const set = new Set<'run' | 'bike' | 'swim'>();
    const restricted = (
      cap: 'yes' | 'limited' | 'no' | undefined,
      capacity: number | undefined,
    ): boolean =>
      cap === 'no' || cap === 'limited'
      || (typeof capacity === 'number' && capacity < 100);
    if (restricted(inj.canRun,  (inj as any).runCapacity))  set.add('run');
    if (restricted(inj.canBike, (inj as any).bikeCapacity)) set.add('bike');
    if (restricted(inj.canSwim, (inj as any).swimCapacity)) set.add('swim');
    return set;
  })();

  const sentence = (() => {
    if (!worstCandidate || overall === 'On Track' || overall === 'Primed') {
      return worstCandidate?.result.sentence ?? 'All disciplines are clear.';
    }
    const cap = (d: string) => d.charAt(0).toUpperCase() + d.slice(1);
    // Exclude injury-restricted others from "not the primary concern". That
    // phrasing implies they are otherwise available, which contradicts the
    // injury context the chip is already showing.
    const others = candidates
      .filter(d => d.disc !== worstCandidate.disc && !injuryRestricted.has(d.disc))
      .map(d => cap(d.disc)).join(' and ');
    // "clear" would contradict the UI cap. Say "not the primary concern" instead.
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
    // baseline for this athlete. Don't blame it for discipline overreaching.
    const crossIsStressed = crossTraining != null
      && LABEL_RANK[crossTraining.label] >= LABEL_RANK['Manage Load'];
    const crossIsDominant = crossTrainingAtl > 0 && crossTrainingAtl > maxDisciplineAtl && crossIsStressed;
    const crossIsSignificant = crossTrainingAtl > 0 && crossTrainingAtl > maxDisciplineAtl * 0.5 && crossIsStressed;

    const upcomingHard = upcomingHardSession;
    const worstDisc = worstCandidate.disc;
    const worstIsInjured = injuryRestricted.has(worstDisc);

    if (overall === 'Overreaching') {
      if (crossIsDominant) {
        return upcomingHard
          ? `Cross-training has pushed your load above baseline. Ease into ${upcomingHard.dayLabel}'s ${upcomingHard.workout.t.replace(/_/g, ' ')} and cut discretionary activity this week.`
          : `Cross-training has pushed your load above baseline. Nothing hard is planned in the next couple of days, so planned sessions are fine. Cut discretionary activity this week.`;
      }
      if (crossIsSignificant) {
        return `${cap(worstDisc)} load is elevated relative to your baseline, with cross-training adding to the total. Reduce ${worstDisc} volume and limit extra activities this week.`;
      }
      // Injured worst: the user is already at a reduced capacity cap (shown by
      // the injury chip), so "Reduce" reads oddly. "Hold" is more accurate.
      // The chip carries the rehab framing, so the sentence stays terse.
      return worstIsInjured
        ? `${cap(worstDisc)} load is climbing fast for an injury phase. Hold ${worstDisc} volume this week.${othersClause}`
        : `${cap(worstDisc)} load is high relative to your baseline. Reduce ${worstDisc} volume this week.${othersClause}`;
    }
    if (overall === 'Ease Back') {
      if (crossIsDominant) {
        return upcomingHard
          ? `Cross-training has added significant load this week. Ease into ${upcomingHard.dayLabel}'s ${upcomingHard.workout.t.replace(/_/g, ' ')} and hold off on extra discretionary activity.`
          : `Cross-training has added significant load this week. Nothing hard is planned in the next couple of days, so planned sessions are fine. Hold off on extra discretionary activity.`;
      }
      const tail = others ? ` ${others} ${others.includes(' and ') ? 'are' : 'is'} fine today.` : '';
      return `${cap(worstDisc)} needs more recovery.${tail}`;
    }
    return `${cap(worstDisc)} load is elevated.${othersClause}`;
  })();

  return { swim, bike, run, crossTraining, overall, sentence };
}
