import type { GpsSplit } from '@/types';

/**
 * Per-km split tolerance by step kind. Retrospective adherence is stricter on
 * quality work (±4 s/km) than on easy or approach/recovery running (±8–10 s/km).
 * The live-coaching generic ±5 s/km band is kept as the fallback for `'other'`.
 */
export const ADHERENCE_TOLERANCE_BY_KIND: Record<SplitCategory['kind'], number> = {
  work: 4,
  recovery: 0,      // never classified — paced recovery is handled as untimed
  warmup: 10,
  cooldown: 10,
  other: 5,
};

/** Fallback tolerance when no kind is available (kept for backwards compatibility). */
export const ADHERENCE_TOLERANCE_SEC_PER_KM = 5;

export type SplitStatus = 'onPace' | 'fast' | 'slow' | 'untimed';

export interface SplitCategory {
  kind: 'warmup' | 'work' | 'recovery' | 'cooldown' | 'other';
}

export interface PacedSplitResult {
  index: number;
  label: string;
  kind: SplitCategory['kind'];
  pace: number;              // actual sec/km
  targetPace: number;        // sec/km
  deviationSec: number;      // pace - targetPace; +ve = slow, -ve = fast
  status: Exclude<SplitStatus, 'untimed'>;
}

export interface AdherenceSummary {
  totalSplits: number;
  paced: PacedSplitResult[];
  onPaceCount: number;
  fastCount: number;
  slowCount: number;
  untimedCount: number;
  avgDeviationSec: number | null;   // mean signed deviation across paced splits, null if none
  hitRate: number | null;            // onPaceCount / paced.length, null if no paced splits
}

/**
 * Classify a split label into a step kind. Labels are free-form strings produced
 * by `buildSplitScheme` so we pattern-match case-insensitively. Anything unrecognised
 * falls through to 'other' (e.g. simple `"km 1"` labels on an easy run).
 */
export function categoriseSplit(label: string): SplitCategory['kind'] {
  const l = label.toLowerCase();
  if (l.includes('warm up')) return 'warmup';
  if (l.includes('cool down')) return 'cooldown';
  if (l.includes('recovery')) return 'recovery';
  if (l.includes('rep') || l.includes('tempo') || l.includes('fast km') || l.includes('interval')) return 'work';
  return 'other';
}

export function classifyPace(
  pace: number,
  targetPace: number,
  kind: SplitCategory['kind'] = 'other',
): Exclude<SplitStatus, 'untimed'> {
  const deviation = pace - targetPace;
  const tolerance = ADHERENCE_TOLERANCE_BY_KIND[kind] ?? ADHERENCE_TOLERANCE_SEC_PER_KM;
  if (Math.abs(deviation) <= tolerance) return 'onPace';
  return deviation > 0 ? 'slow' : 'fast';
}

/**
 * Summarise per-split performance for a recorded workout. Untimed splits
 * (recovery jogs, easy warm-ups with no target) are counted separately —
 * they have no pace target so they're excluded from hit-rate stats.
 */
export function summariseAdherence(splits: GpsSplit[]): AdherenceSummary {
  const paced: PacedSplitResult[] = [];
  let untimedCount = 0;

  for (const split of splits) {
    if (split.targetPace == null || split.pace <= 0 || !isFinite(split.pace)) {
      untimedCount++;
      continue;
    }
    const kind = categoriseSplit(split.label);
    const status = classifyPace(split.pace, split.targetPace, kind);
    paced.push({
      index: split.index,
      label: split.label,
      kind,
      pace: split.pace,
      targetPace: split.targetPace,
      deviationSec: split.pace - split.targetPace,
      status,
    });
  }

  const onPaceCount = paced.filter((p) => p.status === 'onPace').length;
  const fastCount = paced.filter((p) => p.status === 'fast').length;
  const slowCount = paced.filter((p) => p.status === 'slow').length;
  const avgDeviationSec = paced.length > 0
    ? paced.reduce((sum, p) => sum + p.deviationSec, 0) / paced.length
    : null;
  const hitRate = paced.length > 0 ? onPaceCount / paced.length : null;

  return {
    totalSplits: splits.length,
    paced,
    onPaceCount,
    fastCount,
    slowCount,
    untimedCount,
    avgDeviationSec,
    hitRate,
  };
}
