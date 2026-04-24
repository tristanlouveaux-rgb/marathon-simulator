/**
 * Multi-sport transfer matrix.
 *
 * Every activity contributes to its own discipline's CTL and ATL at 1.0, and
 * to other disciplines' CTL and ATL at reduced weights. Transfers ADD ONLY —
 * they never subtract. This generalises the old `runSpec` concept to support
 * triathlon (swim/bike/run first-class) alongside existing cross-training
 * (padel, gym, ski, etc).
 *
 * Spec reference: `docs/TRIATHLON.md` §18.3.
 *
 * **Tracking vs planning**: these values are used on both sides of the line.
 * On the tracking side, they determine how a padel session (for example)
 * contributes to each per-discipline CTL when we analyse history. On the
 * planning side, they drive the replace-and-reduce flow — if a user misses a
 * run but did a long bike, the matrix says the bike counts as 0.75 of a run
 * for aerobic-stimulus substitution purposes.
 */

import type { Discipline } from '../types/triathlon';

/** Sport keys that are "sources" — activities a user can do. */
export type TransferSourceSport =
  | 'run'
  | 'bike'
  | 'swim'
  | 'strength'        // Gym / weights
  | 'padel'
  | 'tennis'
  | 'football'        // Field sport catch-all
  | 'ski_touring'
  | 'hiking'
  | 'other';

/**
 * Transfer coefficients: source sport → destination discipline.
 *
 * Reading: `TRANSFER_MATRIX.run.bike = 0.70` means that doing a run
 * contributes 70% of its TSS to bike CTL/ATL (in addition to 100% going to
 * run CTL/ATL).
 *
 * Citations (triathlon values — §18.3):
 *   - run ↔ bike: Millet et al. (2002) — shared VO2 and cardiac adaptations
 *   - swim ↔ run: Millet & Vleck (2000) — minimal specificity transfer
 *   - strength → aerobic: Beattie et al. (2023) — small but present
 *   - padel / ski values: first-approximation proposals based on physiology;
 *     flagged for validation in §18.11.
 */
export const TRANSFER_MATRIX: Record<TransferSourceSport, Record<Discipline, number>> = {
  run:         { run: 1.00, bike: 0.70, swim: 0.25 },
  bike:        { run: 0.75, bike: 1.00, swim: 0.20 },
  swim:        { run: 0.30, bike: 0.20, swim: 1.00 },
  strength:    { run: 0.10, bike: 0.10, swim: 0.10 },
  padel:       { run: 0.35, bike: 0.20, swim: 0.00 },
  tennis:      { run: 0.35, bike: 0.20, swim: 0.00 },
  football:    { run: 0.45, bike: 0.20, swim: 0.00 },
  ski_touring: { run: 0.55, bike: 0.40, swim: 0.00 },
  hiking:      { run: 0.55, bike: 0.35, swim: 0.00 },
  other:       { run: 0.20, bike: 0.20, swim: 0.05 },
};

/**
 * Get the transfer contribution from a source sport to a destination discipline.
 * Returns 0 if either key is unknown — we do not crash on unexpected sport strings.
 */
export function transferWeight(source: TransferSourceSport, dest: Discipline): number {
  return TRANSFER_MATRIX[source]?.[dest] ?? 0;
}

/**
 * Map a free-form sport label (as stored on activities) into a transfer source key.
 * Kept deliberately small — unmatched sports default to 'other'. Expand as needed.
 */
export function sportToTransferSource(sportLabel: string | undefined): TransferSourceSport {
  if (!sportLabel) return 'other';
  const s = sportLabel.toLowerCase();
  if (s.includes('run')) return 'run';
  if (s.includes('swim')) return 'swim';
  if (s.includes('cycl') || s.includes('bike') || s.includes('ride')) return 'bike';
  if (s.includes('gym') || s.includes('strength') || s.includes('weight') || s.includes('lift')) return 'strength';
  if (s.includes('padel')) return 'padel';
  if (s.includes('tennis') || s.includes('squash') || s.includes('badminton')) return 'tennis';
  if (s.includes('football') || s.includes('soccer') || s.includes('rugby')) return 'football';
  if (s.includes('ski')) return 'ski_touring';
  if (s.includes('hik') || s.includes('walk') || s.includes('trek')) return 'hiking';
  return 'other';
}

/**
 * Combined-CTL weighting for the top-line "total fatigue" number shown on the
 * Home view. Weights sum to 1.0 and are derived from the triathlon
 * time-split defaults (§18.2). For running-mode users this is never used
 * (they see a single CTL).
 */
export const COMBINED_CTL_WEIGHTS: Record<Discipline, number> = {
  swim: 0.175,
  bike: 0.475,
  run:  0.350,
};
