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
  const setCount = comps.map(c => hyroxComponentSets(c, rounds));
  const seen = comps.map(() => 0);
  const out: HyroxWalkSet[] = [];
  for (let r = 1; r <= rounds; r++) {
    const inRound = comps.map((c, ci) => ({ c, ci })).filter(x => hyroxComponentRounds(x.c, rounds).includes(r));
    inRound.forEach((x, k) => {
      const next = inRound[k + 1];
      out.push({
        ci: x.ci,
        component: x.c,
        round: r,
        setIndex: seen[x.ci]++,
        setCount: setCount[x.ci],
        restSec: next ? Math.max(0, Math.round(x.c.restAfterSec ?? 0)) : roundRest,
        transitionSec: next && x.c.type === 'run' && next.c.type !== 'run' ? transition : 0,
      });
    });
  }
  // No rest after the final set.
  if (out.length > 0) out[out.length - 1].restSec = 0;
  return out;
}

/** Length of a session (seconds): every set's work, the rest after it and
 *  the transition jogs. */
export function hyroxSessionDurationSec(w: Pick<Workout, 'hyroxComponents' | 'hyroxRounds' | 'hyroxRoundRestSec' | 'hyroxSpec'>): number {
  return hyroxSessionWalk(w).reduce((sum, s) => sum + (s.component.durationSec ?? 0) + s.restSec + s.transitionSec, 0);
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
  if (typeof c.reps === 'number') return `${c.reps} reps`;
  if (c.raceFraction == null || c.distanceM == null) return STATION_DISPLAY[station]?.distance ?? '';
  if (station === 'sled_push' || station === 'sled_pull') {
    const lanes = c.distanceM / HYROX_SLED_LANE_M;
    return `${fmtAmount(lanes)} lane${lanes === 1 ? '' : 's'} (${fmtAmount(c.distanceM)} m)`;
  }
  return `${fmtAmount(c.distanceM)} m`;
}
