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
  /** Last working weight actually lifted (kg). Optional: a lift seeded by a
   *  manual 1RM entry has a benchmark (est1rmKg) but no logged working set. */
  lastWeightKg?: number;
  /** Rep scheme the last weight was lifted at, e.g. "8" or "5". */
  lastReps?: string;
  /** RIR bucket from the last session's final set. */
  lastRir?: RirBucket;
  /** ISO date (YYYY-MM-DD) of the last logged session for this lift. */
  lastDate: string;
  /** Estimated-1RM (kg), Epley-derived. Mirrors the FTP/CSS benchmark role.
   *  Only advances on a comparable-or-stronger effort (reps <= est1rmReps) —
   *  1RM estimates inflate with reps, so a high-rep day must not move it. */
  est1rmKg?: number;
  /** Rep count the current est1rmKg was derived at. Used to gate the next
   *  update so cross-rep-scheme Epley noise can't mint a false PR. */
  est1rmReps?: number;
  /** Provenance, mirroring FTP/CSS/VDOT. 'derived' = Epley from a logged working
   *  set; 'user' = the athlete entered a 1RM (or a weight x reps we derived from)
   *  on the Stats strength page. A 'user' value is overridden the moment a logged
   *  set produces a comparable-or-stronger Epley estimate (the est1rmReps gate),
   *  at which point provenance flips back to 'derived'. */
  est1rmSource?: 'user' | 'derived';
  /** ISO date the est1RM was last updated. */
  est1rmUpdatedAt?: string;
  /** Append-only history powering the per-lift trend chart. Only advancing
   *  (PB-staircase) samples are appended, so the trend can't dip on a high-rep
   *  day. `reps` records the effort each best was set at. */
  est1rmHistory?: Array<{ date: string; value: number; reps?: number }>;
}

export interface StrengthLog {
  /** Per-lift memory, keyed by canonical slug. */
  lifts: Record<string, StrengthLiftEntry>;
  /** Last-notified est1RM per lift key. PR-toast snapshot, mirrors notifiedMarkers. */
  notifiedPr?: Record<string, number>;
}

/** Movement families that beginners/novices progress through a bodyweight ladder.
 *  See `src/calculations/bodyweight-progression.ts` for the ladder content. */
export type BodyweightFamily = 'squat' | 'lunge' | 'hinge' | 'calf' | 'plank' | 'step-up';

/**
 * Per-movement-family bodyweight progression, the bodyweight analog of
 * `StrengthLiftEntry`. Weight-tracking is meaningless for bodyweight work, so we
 * remember a LADDER RUNG instead and advance it from the same RIR feedback the
 * guided player already collects. Mirrors the weight autoregulation (advance in
 * base/build when consistently easy). See `bodyweight-progression.ts`.
 */
export interface BodyweightProgressEntry {
  /** Movement family (also the record key). */
  family: BodyweightFamily;
  /** Current rung index into the family's ladder (0 = entry level). */
  level: number;
  /** Consecutive "reps-left" (easy) sessions toward the next advance. */
  easyStreak: number;
  /** Last RIR bucket logged for this family. */
  lastRir?: RirBucket;
  /** ISO date (YYYY-MM-DD) of the last logged session for this family. */
  lastDate: string;
}
