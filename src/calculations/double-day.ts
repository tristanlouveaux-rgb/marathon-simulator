/**
 * Double-day compounding — same-calendar-day session stacking carries more
 * physiological cost than pure additive TSS suggests.
 *
 * Science (see docs/SCIENCE_LOG.md → "Double-day stacking"):
 *   - Glycogen replete ~50% at 6h post-session, full at ~24h (Burke et al.)
 *   - Cardiac drift + residual lactate elevated 2–6h post-session (Coyle)
 *   - CNS + hormonal carryover persists 12–24h (Borresen & Lambert 2009)
 *
 * Multiplier on the 2nd+ qualifying session's raw TSS, by start-to-start gap:
 *   <2h  → ×1.20 (near-brick stress, minimal recovery)
 *   2–6h → ×1.15 (substantial glycogen deficit)
 *   6–12h → ×1.10 (partial replete; mild CNS carryover)
 *   ≥12h → ×1.05 (minimal compounding)
 *
 * The bonus is applied to the day-level Signal B aggregate (CTL/ATL/ACWR/
 * Readiness inputs). Per-activity TSS in Activity Review stays raw — the
 * *session* didn't get harder; the *day's recovery debt* did.
 *
 * Side of the line: tracking. Describes day-level stress after the fact.
 */

import { TL_PER_MIN } from '@/constants';
import { detectBricks, type DetectionActivity } from '@/calculations/brick-detector';
import { computeStrengthRpeTSS, normalizeiTrimp } from '@/calculations/fitness-model';
import type { Week, GarminActual, Workout } from '@/types/state';

/** Sessions shorter than this don't trigger compounding (filters out short accessory work). */
export const DOUBLE_DAY_MIN_SESSION_MIN = 20;

/** Bike→run gap (sec) within which two activities are treated as one (brick). Mirrors brick-detector. */
const UNPLANNED_BRICK_GAP_SEC = 30 * 60;

export interface DoubleDayDay {
  /** ISO date YYYY-MM-DD (local calendar). */
  dateISO: string;
  /** Number of qualifying sessions on this day (brick pair collapses to 1). */
  sessionCount: number;
  /** Compounding bonus TSS added to day total (rounded). */
  bonusTSS: number;
  /** Smallest start-to-start gap (minutes) between consecutive qualifying sessions. */
  smallestGapMin: number;
  /** IDs of the 2nd+ sessions in start-time order (used for activity-row caption). */
  secondarySessionIds: string[];
  /** True when a planned brick workout was scheduled on this day — compounding suppressed. */
  hadPlannedBrick: boolean;
}

interface Session {
  /** Stable id (garminId or adhoc workout id). */
  id: string;
  /** Start time in ms since epoch. */
  startMs: number;
  /** Duration in minutes. */
  durationMin: number;
  /** Raw (Signal B) TSS contribution from this session alone. */
  rawTSS: number;
  /** Loose sport string for brick pairing. */
  sport: string;
  /** ISO date YYYY-MM-DD (local). */
  dateISO: string;
}

/** Multiplier on the 2nd+ session's raw TSS, by start-to-start gap (minutes). */
export function doubleDayGapMultiplier(gapMin: number): number {
  if (gapMin < 120) return 1.20;
  if (gapMin < 360) return 1.15;
  if (gapMin < 720) return 1.10;
  return 1.05;
}

/**
 * Intensity scalar applied to the gap multiplier's *excess* (mult − 1), based
 * on the FIRST session's TSS/minute. The first session creates the depleted
 * state; its intensity determines how depleted that state is.
 *
 * Calibrated against Coggan & Allen 2019 intensity-factor zones via
 * TSS/min = (IF² × 100) / 60:
 *   - IF < ~0.77  (recovery → mid-tempo)  → TSS/min < 1.0  → 0.85× (less depletion)
 *   - IF 0.77–0.95 (tempo → sub-LT)       → TSS/min 1.0–1.5 → 1.00× (baseline)
 *   - IF ≥ 0.95   (LT+)                   → TSS/min ≥ 1.5  → 1.15× (more depletion)
 *
 * The 2nd session's own TSS is already in the bonus expression (`rawTSS_2 ×
 * (effMult − 1)`), so this scalar specifically captures the depletion-state
 * effect from the preceding session, not the 2nd session's own intensity.
 */
export function doubleDayIntensityScalar(firstSessionTSSPerMin: number): number {
  if (firstSessionTSSPerMin >= 1.5) return 1.15;
  if (firstSessionTSSPerMin >= 1.0) return 1.00;
  return 0.85;
}

function localDateISO(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sportFromActual(a: GarminActual): string {
  return (a.manualSport ?? a.activityType ?? '').toString().toLowerCase();
}

/** Raw (Signal B) TSS for a single matched actual — mirrors computeWeekRawTSS path. */
function rawTSSForActual(a: GarminActual, ratedRpe: number | null, norm?: number): number {
  const strengthOverride = computeStrengthRpeTSS(a, false, ratedRpe);
  if (strengthOverride != null) return strengthOverride;
  if (a.iTrimp != null && a.iTrimp > 0) return normalizeiTrimp(a.iTrimp, norm);
  const rpe = ratedRpe ?? 5;
  const durMin = a.durationSec > 0 ? a.durationSec / 60 : a.distanceKm * 6;
  return durMin * (TL_PER_MIN[Math.round(rpe)] ?? 0.92);
}

/** Raw (Signal B) TSS for a single adhoc workout — mirrors computeWeekRawTSS path. */
function rawTSSForAdhoc(w: Workout, norm?: number): number {
  if (w.iTrimp != null && w.iTrimp > 0) return normalizeiTrimp(w.iTrimp, norm);
  const rpe = (w as any).rpe ?? (w as any).r ?? 5;
  const durMin = parseDurMinFromDesc((w as any).d ?? '');
  return durMin * (TL_PER_MIN[Math.round(rpe)] ?? 1.15);
}

function parseDurMinFromDesc(d: string): number {
  const m = d.match(/(\d+)min/);
  return m ? parseInt(m[1], 10) : 30;
}

function durationMinForActual(a: GarminActual): number {
  return a.durationSec > 0 ? a.durationSec / 60 : a.distanceKm * 6;
}

function startMsForAdhoc(w: Workout): number | null {
  const ts = (w as any).garminTimestamp as string | undefined;
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isPlannedBrickWorkout(w: Workout): boolean {
  const t = (w.t ?? '').toLowerCase();
  return t === 'brick' || t === 'hyrox_brick' || t === 'hyrox_mini_brick';
}

/**
 * For a single week, return per-day double-day metadata. Days without
 * ≥2 qualifying sessions (or with a planned brick) are omitted.
 *
 * @param wk             - Plan week with garminActuals/adhocWorkouts populated
 * @param planStartDate  - ISO Monday of plan week 1 (used to map workout dayOfWeek → date)
 * @param norm           - Athlete iTRIMP normaliser (passes through to TSS computation)
 */
export function computeWeekDoubleDayDays(
  wk: Week,
  planStartDate?: string,
  norm?: number,
): DoubleDayDay[] {
  const sessions: Session[] = [];
  const seenGarminIds = new Set<string>();

  // garminActuals
  for (const [workoutId, a] of Object.entries(wk.garminActuals ?? {})) {
    if (!a.startTime) continue;
    const startMs = new Date(a.startTime).getTime();
    if (!Number.isFinite(startMs)) continue;
    if (a.garminId) {
      if (seenGarminIds.has(a.garminId)) continue;
      seenGarminIds.add(a.garminId);
    }
    const durationMin = durationMinForActual(a);
    if (durationMin < DOUBLE_DAY_MIN_SESSION_MIN) continue;
    const ratedVal = wk.rated?.[workoutId];
    const ratedRpe = (typeof ratedVal === 'number') ? ratedVal : null;
    sessions.push({
      id: a.garminId ?? workoutId,
      startMs,
      durationMin,
      rawTSS: rawTSSForActual(a, ratedRpe, norm),
      sport: sportFromActual(a),
      dateISO: localDateISO(startMs),
    });
  }

  // adhocWorkouts (Garmin-prefixed and freeform)
  for (const w of wk.adhocWorkouts ?? []) {
    if (w.id?.startsWith('holiday-') || w.id?.startsWith('adhoc-')) continue;
    if (w.id && (wk.garminActuals as any)?.[w.id]) continue;
    const rawId = w.id?.startsWith('garmin-') ? w.id.slice('garmin-'.length) : null;
    if (rawId) {
      if (seenGarminIds.has(rawId)) continue;
      seenGarminIds.add(rawId);
    }
    const startMs = startMsForAdhoc(w);
    if (startMs == null) continue;
    const durationMin = parseDurMinFromDesc((w as any).d ?? '');
    if (durationMin < DOUBLE_DAY_MIN_SESSION_MIN) continue;
    sessions.push({
      id: w.id ?? `adhoc-${startMs}`,
      startMs,
      durationMin,
      rawTSS: rawTSSForAdhoc(w, norm),
      sport: ((w as any).n ?? w.t ?? '').toString().toLowerCase(),
      dateISO: localDateISO(startMs),
    });
  }

  if (sessions.length < 2) return [];

  // Planned-brick day set — collapse to ISO dates from workout dayOfWeek + week index.
  const plannedBrickDates = new Set<string>();
  if (planStartDate && wk.w != null) {
    const weekStartMs = new Date(planStartDate + 'T00:00:00').getTime() + (wk.w - 1) * 7 * 86400000;
    // Tri + HYROX store generated workouts on `triWorkouts`. Running mode
    // regenerates on the fly and has no planned-brick concept, so the
    // running case naturally falls through.
    for (const w of (wk.triWorkouts ?? [])) {
      if (!isPlannedBrickWorkout(w)) continue;
      const dow = w.dayOfWeek;
      if (dow == null || dow < 0 || dow > 6) continue;
      plannedBrickDates.add(localDateISO(weekStartMs + dow * 86400000));
    }
  }

  // Group by ISO date.
  const byDate = new Map<string, Session[]>();
  for (const s of sessions) {
    const list = byDate.get(s.dateISO) ?? [];
    list.push(s);
    byDate.set(s.dateISO, list);
  }

  const days: DoubleDayDay[] = [];

  for (const [dateISO, daySessions] of byDate) {
    if (daySessions.length < 2) continue;
    if (plannedBrickDates.has(dateISO)) continue;

    daySessions.sort((a, b) => a.startMs - b.startMs);

    // Collapse unplanned bike→run within 30 min into a single virtual session.
    const detectInput: DetectionActivity[] = daySessions.map((s) => ({
      id: s.id,
      sport: s.sport,
      startTs: s.startMs / 1000,
      durationSec: s.durationMin * 60,
    }));
    const bricks = detectBricks(detectInput);
    const pairedRunIds = new Set(bricks.map((b) => b.runId));
    const collapsed: Session[] = [];
    for (const s of daySessions) {
      if (pairedRunIds.has(s.id)) {
        // Roll the run's TSS + duration into the preceding bike session.
        const prev = collapsed[collapsed.length - 1];
        if (prev) {
          prev.rawTSS += s.rawTSS;
          prev.durationMin += s.durationMin;
        }
        continue;
      }
      collapsed.push({ ...s });
    }

    if (collapsed.length < 2) continue;

    let bonusTSS = 0;
    let smallestGapMin = Infinity;
    const secondaryIds: string[] = [];

    for (let i = 1; i < collapsed.length; i++) {
      const gapMin = (collapsed[i].startMs - collapsed[i - 1].startMs) / 60000;
      const gapMult = doubleDayGapMultiplier(gapMin);
      // Intensity scalar from the PRECEDING session (it determines depletion state).
      const firstTSSPerMin = collapsed[i - 1].durationMin > 0
        ? collapsed[i - 1].rawTSS / collapsed[i - 1].durationMin
        : 0;
      const intensityScalar = doubleDayIntensityScalar(firstTSSPerMin);
      const effMult = 1 + (gapMult - 1) * intensityScalar;
      const bonus = collapsed[i].rawTSS * (effMult - 1);
      bonusTSS += bonus;
      smallestGapMin = Math.min(smallestGapMin, gapMin);
      secondaryIds.push(collapsed[i].id);
    }

    if (bonusTSS <= 0) continue;

    days.push({
      dateISO,
      sessionCount: collapsed.length,
      bonusTSS: Math.round(bonusTSS),
      smallestGapMin: Math.round(smallestGapMin),
      secondarySessionIds: secondaryIds,
      hadPlannedBrick: false,
    });
  }

  return days;
}

/** Total weekly compounding bonus across all double-day days. */
export function computeWeekDoubleDayBonus(
  wk: Week,
  planStartDate?: string,
  norm?: number,
): number {
  const days = computeWeekDoubleDayDays(wk, planStartDate, norm);
  return days.reduce((acc, d) => acc + d.bonusTSS, 0);
}

/** Today's compounding bonus only (used by live Strain/Today TSS). */
export function computeTodayDoubleDayBonus(
  wk: Week,
  todayISO: string,
  planStartDate?: string,
  norm?: number,
): number {
  const days = computeWeekDoubleDayDays(wk, planStartDate, norm);
  const today = days.find((d) => d.dateISO === todayISO);
  return today?.bonusTSS ?? 0;
}

