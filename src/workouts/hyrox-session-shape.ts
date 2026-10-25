/**
 * The shape of a HYROX station session or brick: which component each set
 * belongs to, the order the sets run in, the rest after each, and the
 * session's length. One walk shared by the generators (duration), the MTL cap
 * cuts (withHyroxRounds), the guided player (parseHyroxSession) and the
 * prescription text, so the four never disagree.
 *
 * A session runs `hyroxRounds` rounds through its components in order. A
 * component with `inRounds` appears only in those rounds (lane H2b: a
 * beginner's sled takes 4 sets of one lane while the other stations take 2; a
 * brick's two stations alternate rounds). Rest after a set: the component's
 * own `restAfterSec`, the session's `hyroxRoundRestSec` after the last set of
 * a round, none after the final set. Bricks add a transition jog from each run
 * to the station that follows it (hyroxSpec.transitionSec), counted in the
 * duration but not shown as rest.
 *
 * Side of the line: planning (shape of a prescription). Pure.
 */

import type { Workout } from '@/types/state';
import type { HyroxComponent, HyroxStation } from '@/types/triathlon';
import { STATION_DISPLAY } from '@/constants/hyrox-benchmarks';
import { plannedTssPerMin } from '@/constants/sports';
import { HYROX_EASY_RPE } from '@/constants/hyrox-constants';

/** Length of one HYROX sled lane (m). Sled push and pull run as 4 lanes of
 *  12.5 m (26/27 Singles rulebook s8; the parameter sheet's rules_to_code), so
 *  training sets count lanes. */
export const HYROX_SLED_LANE_M = 12.5;

/** The rounds (1-based, ascending) a component appears in, within `rounds`. */
export function hyroxComponentRounds(c: Pick<HyroxComponent, 'inRounds'>, rounds: number): number[] {
  const n = Math.max(0, Math.round(rounds));
  if (c.inRounds) return c.inRounds.filter(r => r >= 1 && r <= n);
  return Array.from({ length: n }, (_, i) => i + 1);
}

/** Sets of a component within `rounds` (its rounds count). */
export function hyroxComponentSets(c: Pick<HyroxComponent, 'inRounds'>, rounds: number): number {
  return hyroxComponentRounds(c, rounds).length;
}

/** One set of a session's walk, in the order it is done. */
export interface HyroxWalkSet {
  /** Index of the component in hyroxComponents. */
  ci: number;
  component: HyroxComponent;
  /** 1-based round. */
  round: number;
  /** 0-based set number within the component's own sets. */
  setIndex: number;
  /** The component's set count. */
  setCount: number;
  /** Rest after this set (seconds). */
  restSec: number;
  /** Jog after this set to the station that follows (bricks), seconds. */
  transitionSec: number;
}

/** Every set of a session in order, with the rest after each. */
export function hyroxSessionWalk(w: Pick<Workout, 'hyroxComponents' | 'hyroxRounds' | 'hyroxRoundRestSec' | 'hyroxSpec'>): HyroxWalkSet[] {
  const comps = w.hyroxComponents ?? [];
  const rounds = Math.max(1, Math.round(w.hyroxRounds ?? 1));
  const roundRest = Math.max(0, Math.round(w.hyroxRoundRestSec ?? 0));
  const transition = Math.max(0, Math.round(w.hyroxSpec?.transitionSec ?? 0));
  // Each component's rounds, read once (the walk runs at every duration,
  // cut and text of a session).
  const roundSets = comps.map(c => new Set(hyroxComponentRounds(c, rounds)));
  const setCount = roundSets.map(rs => rs.size);
  const seen = comps.map(() => 0);
  const out: HyroxWalkSet[] = [];
  for (let r = 1; r <= rounds; r++) {
    const inRound: Array<{ c: HyroxComponent; ci: number }> = [];
    for (let ci = 0; ci < comps.length; ci++) if (roundSets[ci].has(r)) inRound.push({ c: comps[ci], ci });
    inRound.forEach((x, k) => {
      const next = inRound[k + 1];
      // A set the injury gates cut takes their share of the rest after it
      // (restScale), rounded down to the whole second.
      const scale = x.c.restScale;
      const scaled = (sec: number) => (scale == null ? sec : Math.floor(sec * Math.max(0, scale) + 1e-9));
      out.push({
        ci: x.ci,
        component: x.c,
        round: r,
        setIndex: seen[x.ci]++,
        setCount: setCount[x.ci],
        restSec: scaled(next ? Math.max(0, Math.round(x.c.restAfterSec ?? 0)) : roundRest),
        transitionSec: next && x.c.type === 'run' && next.c.type !== 'run' ? scaled(transition) : 0,
      });
    });
  }
  // No rest after the final set.
  if (out.length > 0) out[out.length - 1].restSec = 0;
  return out;
}

/** Minutes of a session's parts around its station work (lane H2b part 2):
 *  the warm-up, the strength block and the easy erg finisher. */
export function hyroxSessionPartsMin(w: Pick<Workout, 'hyroxSpec'>): { easy: number; strength: number } {
  const spec = w.hyroxSpec;
  return {
    easy: (spec?.warmup?.min ?? 0) + (spec?.finisher?.min ?? 0),
    strength: spec?.strength?.min ?? 0,
  };
}

/** Length of a session's station work (seconds): every set's work, the rest
 *  after it and the transition jogs. */
export function hyroxSessionWorkSec(w: Pick<Workout, 'hyroxComponents' | 'hyroxRounds' | 'hyroxRoundRestSec' | 'hyroxSpec'>): number {
  return hyroxSessionWalk(w).reduce((sum, s) => sum + (s.component.durationSec ?? 0) + s.restSec + s.transitionSec, 0);
}

/** Length of a session's first round (seconds): its sets' work, the rest
 *  after each and the transition jogs. A station session with no warm-up
 *  left takes it at the easy RPE as the warm-up (hyroxSpec.warmupRound): the
 *  15-min station floor counts the station work after it, and planned TSS
 *  prices it at the easy RPE (review round 7). */
export function hyroxRoundOneSec(w: Pick<Workout, 'hyroxComponents' | 'hyroxRounds' | 'hyroxRoundRestSec' | 'hyroxSpec'>): number {
  return hyroxSessionWalk(w).filter(s => s.round === 1).reduce((sum, s) => sum + (s.component.durationSec ?? 0) + s.restSec + s.transitionSec, 0);
}

/** Length of a session (seconds): its station work and the parts around it
 *  (the warm-up, the strength block, the finisher). */
export function hyroxSessionDurationSec(w: Pick<Workout, 'hyroxComponents' | 'hyroxRounds' | 'hyroxRoundRestSec' | 'hyroxSpec'>): number {
  const parts = hyroxSessionPartsMin(w);
  return hyroxSessionWorkSec(w) + (parts.easy + parts.strength) * 60;
}

/**
 * Planned load of a HYROX session in canonical TSS (the Load Currency Law:
 * planned sessions price at plannedTssPerMin of their type). A lane H2b part
 * 2 session prices each part at its own effort: the warm-up and the finisher
 * at the easy RPE (HYROX_EASY_RPE), the strength block at its RPE as a gym
 * session, the station work at the session's RPE. Round 1 as the warm-up
 * (hyroxSpec.warmupRound: the injury gates left no warm-up) prices at the
 * easy RPE too, as its MTL does (finishHyroxSession), so the session's two
 * load figures follow one rule (review round 7: its TSS priced round 1 at the
 * session's RPE). Any other session: its duration at its type and RPE, as
 * before. One source for the plan engine (hyroxPlannedTss: the acute:chronic
 * guard, the deload and taper ceilings) and the planned-day pricer
 * (ui/planned-day-tss.ts).
 */
export function hyroxSessionPlannedTss(w: Pick<Workout, 't' | 'rpe' | 'r' | 'estimatedDurationMin' | 'hyroxSpec' | 'hyroxComponents' | 'hyroxRounds' | 'hyroxRoundRestSec'>): number {
  const dur = w.estimatedDurationMin ?? 0;
  const rpe = w.rpe ?? w.r ?? 5;
  const rate = plannedTssPerMin(w.t ?? '', rpe);
  if (!w.hyroxSpec) return dur * rate;
  const parts = hyroxSessionPartsMin(w);
  // Round 1 at the easy RPE (only above it, as the MTL's rule). Priced from
  // the session's seconds, so a set that grows never lowers the price (the
  // rounded length less round 1 can fall as round 1 grows).
  const easyRound = w.hyroxSpec.warmupRound && rpe > HYROX_EASY_RPE ? hyroxRoundOneSec(w) / 60 : 0;
  if (easyRound > 0) {
    return Math.max(0, hyroxSessionWorkSec(w) / 60 - easyRound) * rate
      + (parts.easy + easyRound) * plannedTssPerMin('', HYROX_EASY_RPE)
      + parts.strength * plannedTssPerMin('gym', w.hyroxSpec.strength?.rpe ?? rpe);
  }
  if (parts.easy + parts.strength <= 0) return dur * rate;
  // The work is what the parts leave of the session's length (never
  // negative).
  const work = Math.max(0, dur - parts.easy - parts.strength);
  return work * rate
    + parts.easy * plannedTssPerMin('', HYROX_EASY_RPE)
    + parts.strength * plannedTssPerMin('gym', w.hyroxSpec.strength?.rpe ?? rpe);
}

/** Format a number for a prescription: whole numbers bare, else one decimal
 *  (12.5 m, 9.6 kg). */
export function fmtAmount(x: number): string {
  return Number.isInteger(x) ? String(x) : (Math.round(x * 10) / 10).toFixed(1);
}

/**
 * What one set of a component asks for: "250 m", "1 lane (12.5 m)", "25
 * reps", "1 km". A component generated before generator v19 carries the full
 * station (its reps, else the race distance).
 */
export function hyroxComponentAmount(c: HyroxComponent): string {
  if (c.type === 'run') {
    const m = c.distanceM ?? 0;
    return m >= 1000 ? `${fmtAmount(m / 1000)} km` : `${fmtAmount(m)} m`;
  }
  const station = c.type as HyroxStation;
  if (typeof c.reps === 'number') return `${c.reps} ${c.reps === 1 ? 'rep' : 'reps'}`;
  if (c.raceFraction == null || c.distanceM == null) return STATION_DISPLAY[station]?.distance ?? '';
  if (station === 'sled_push' || station === 'sled_pull') {
    const lanes = c.distanceM / HYROX_SLED_LANE_M;
    return `${fmtAmount(lanes)} lane${lanes === 1 ? '' : 's'} (${fmtAmount(c.distanceM)} m)`;
  }
  return `${fmtAmount(c.distanceM)} m`;
}
