/**
 * Strength working-weight memory.
 *
 * A rolling, per-lift record of the actual weight the user lifted, keyed by a
 * canonical exercise slug (see `strength-exercise-key.ts`). This is the data
 * that lets the app say "Last time: 60kg x 8" and suggest a phase-aware bump.
 *
 * It also doubles as a per-lift estimated-1RM benchmark, mirroring how FTP /
 * CSS / VDOT are tracked: a `derived` provenance, an append-only history that
 * powers the per-lift trend chart, and a notify-once PR snapshot.
 *
 * Pure tracking. No plan calculation reads from these arrays; progression
 * suggestions are computed on demand from `lastWeightKg` + `lastRir` + phase.
 *
 * All weights are kilograms. There is no weight-unit preference yet
 * (`s.unitPref` is distance-only).
 */

/** One-tap reps-in-reserve bucket captured after the last set of an exercise. */
export type RirBucket = 'reps-left' | 'about-right' | 'barely';

export interface StrengthLiftEntry {
  /** Canonical slug, e.g. "back-squat". Also the record key. */
  key: string;
  /** Human label as last seen, e.g. "Back Squat". */
  displayName: string;
  /** Last working weight actually lifted (kg). */
  lastWeightKg: number;
  /** Rep scheme the last weight was lifted at, e.g. "8" or "5". */
  lastReps: string;
  /** RIR bucket from the last session's final set. */
  lastRir?: RirBucket;
  /** ISO date (YYYY-MM-DD) of the last logged session for this lift. */
  lastDate: string;
  /** Estimated-1RM (kg), Epley-derived. Mirrors the FTP/CSS benchmark role. */
  est1rmKg?: number;
  /** Always 'derived' (Epley from a working set); kept for parity/provenance. */
  est1rmSource?: 'derived';
  /** ISO date the est1RM was last updated. */
  est1rmUpdatedAt?: string;
  /** Append-only history powering the per-lift trend chart. */
  est1rmHistory?: Array<{ date: string; value: number }>;
}

export interface StrengthLog {
  /** Per-lift memory, keyed by canonical slug. */
  lifts: Record<string, StrengthLiftEntry>;
  /** Last-notified est1RM per lift key. PR-toast snapshot, mirrors notifiedMarkers. */
  notifiedPr?: Record<string, number>;
}
