/**
 * Session-generator recommendation helper. Produces a one-line caption shown
 * above the session-type picker so the user sees the system's read on their
 * current state before they choose what to do.
 *
 * Deterministic. No LLM. Reuses `computeReadiness` (the same composite that
 * drives the home Readiness ring) for the readiness score + driving signal,
 * and `buildInjuryCaption` for the blocked/capped sentence. Injury always
 * leads — it represents a hard constraint on what the user can train today;
 * readiness is the softer "how taxed are you" follow-up.
 *
 * Used by `src/ui/session-generator.ts`. Mode-agnostic — running / triathlon
 * / cycling / hyrox all call the same builder; the caption itself is the
 * same across modes because the underlying signals (sleep, HRV, TSB, ACWR,
 * injury) don't change based on which sport the user is about to do.
 */

import type { SimulatorState } from '@/types';
import { computeReadiness, type ReadinessResult } from './readiness';
import { computeFitnessModel, computeLiveSameSignalTSB, computeReadinessACWR } from './fitness-model';
import { buildInjuryCaption } from '@/ui/injury/modal';

export interface SessionRecommendation {
  /** One-line caption like "Readiness 42. Tired but adapted. Easy effort today." */
  caption: string;
  /** Composite readiness score (0-100) when available, else null. */
  readinessScore: number | null;
  /** Driving sub-signal (sleep / hrv / tsb / acwr / etc.) when readiness was computed. */
  drivingSignal: ReadinessResult['drivingSignal'] | null;
  /** The slot we'd suggest if the user said "just pick one". Not used for any
   *  hard gating — only consumed by the caption / future default-select UX. */
  recommendedSlot: 'easy' | 'steady' | 'hard';
}

export function buildSessionRecommendation(s: SimulatorState): SessionRecommendation {
  const injuryLine = buildInjuryCaption(s);

  // Same payload shape coach-workout-modal uses. Leaner than home-view because
  // we don't need recovery-score override, leg-load decay, or strain-pct here.
  const phys = s.physiologyHistory ?? [];
  const hrvAll = phys.map(p => (p as { hrvRmssd?: number | null }).hrvRmssd)
    .filter((v): v is number => typeof v === 'number');
  const hrvAvg = hrvAll.length >= 3
    ? Math.round(hrvAll.reduce((a, b) => a + b, 0) / hrvAll.length)
    : null;
  const lastPhys = phys.slice(-1)[0] ?? null;
  const lastHrv = phys.slice().reverse().find(p =>
    typeof (p as { hrvRmssd?: number | null }).hrvRmssd === 'number',
  ) as { hrvRmssd?: number | null } | undefined;

  const wks = s.wks ?? [];

  let readiness: ReadinessResult | null = null;
  try {
    const tsbResult = computeLiveSameSignalTSB(
      wks,
      s.w,
      s.signalBBaseline ?? undefined,
      s.ctlBaseline ?? undefined,
      s.planStartDate,
      s.previousPlanWks as Parameters<typeof computeLiveSameSignalTSB>[5],
    );
    const acwrResult = computeReadinessACWR(s);
    // History depth and ACWR ceiling exactly as the Home readiness ring reads
    // them (home-view buildReadinessRing): completed live weeks plus archived
    // weeks, and the tier's safeUpper. `Math.min(wks.length, 4)` was always >= 3
    // on a real plan, so the ACWR hard floor applied here weeks before the ring.
    const atlSeed = (s.ctlBaseline ?? 0) * (1 + Math.min(0.1 * (s.gs ?? 0), 0.3));
    const historyWeeks = computeFitnessModel(
      wks, Math.max(0, s.w - 1), s.ctlBaseline ?? undefined, s.planStartDate, atlSeed, undefined,
      s.previousPlanWks as Parameters<typeof computeFitnessModel>[6],
    ).length;
    readiness = computeReadiness({
      tsb: tsbResult.tsb,
      acwr: acwrResult.ratio,
      ctlNow: s.ctlBaseline ?? 0,
      sleepScore: (lastPhys as { sleepScore?: number | null } | null)?.sleepScore ?? null,
      sleepHistory: phys,
      hrvRmssd: lastHrv?.hrvRmssd ?? null,
      hrvPersonalAvg: hrvAvg,
      sleepBankSec: null,
      weeksOfHistory: historyWeeks,
      acwrSafeUpper: acwrResult.safeUpper,
    });
  } catch {
    // computeReadiness errors fall through to a caption that's only the
    // injury line (or empty). Generator UI degrades silently.
  }

  const score = readiness?.score ?? null;
  const sentence = readiness?.sentence ?? '';

  // Score thresholds mirror the readiness label gradient (see readiness.ts).
  // Anyone with injury never gets a 'hard' suggestion regardless of score.
  let recommendedSlot: 'easy' | 'steady' | 'hard' = 'steady';
  if (score != null) {
    if (score < 45) recommendedSlot = 'easy';
    else if (score >= 75) recommendedSlot = 'hard';
  }
  if (injuryLine && recommendedSlot === 'hard') recommendedSlot = 'steady';

  const captionParts: string[] = [];
  if (injuryLine) captionParts.push(injuryLine);
  if (score != null && sentence) {
    captionParts.push(`Readiness ${Math.round(score)}. ${sentence}`);
  } else if (sentence) {
    captionParts.push(sentence);
  }

  return {
    caption: captionParts.join(' '),
    readinessScore: score,
    drivingSignal: readiness?.drivingSignal ?? null,
    recommendedSlot,
  };
}
