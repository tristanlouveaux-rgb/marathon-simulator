/**
 * Who entered a slot's rating (lane H2b review). Tracking side.
 *
 * `wk.rated` holds every rating a slot gets. Some are the athlete's own: an
 * RPE prompt, the guided player's 1-tap rating, Mark as done at the planned
 * RPE, the activity-detail slider, the watch's self-reported RPE. Others are
 * the app's estimates: deriveRPE's heart-rate-reserve and Training Effect
 * mappings when a synced recording fills a slot, the cross-training
 * matcher's expected RPE. A reader that must act only on what the athlete
 * said reads `athleteRatedRpe`; today that is the HYROX beginner load step,
 * which follows strength-progression's suggestNextWeight and so needs the
 * athlete's own effort report (SCIENCE_LOG Strength Tracking: RIR is entered
 * per lift). A technique session with 2 min rest after every set averages a
 * low heart rate, so deriveRPE reads it as RPE 3 or 4, under the target of 5,
 * and every loaded station would climb without the athlete rating anything.
 *
 * `wk.ratedByAthlete` stores the number the athlete entered. A rating counts
 * as the athlete's only while `wk.rated` still holds that number: a later
 * estimate, a skip or an unrate supersedes it without every writer of
 * `wk.rated` having to keep this map in step. A missing entry reads as "not
 * the athlete's", which holds a load rather than climbing it.
 */
import type { Week } from '@/types/state';

/** 'user': the athlete entered the rating. 'derived': the app estimated it. */
export type RatingSource = 'user' | 'derived';

type RatedWeek = Pick<Week, 'rated' | 'ratedByAthlete'>;

/** Record who entered the rating `wk.rated[id]` now holds. Call it after the
 *  write. A 'derived' or non-numeric rating clears the athlete's entry. */
export function noteRatingSource(wk: RatedWeek, id: string, source: RatingSource): void {
  const v = wk.rated?.[id];
  if (source === 'user' && typeof v === 'number') {
    if (!wk.ratedByAthlete) wk.ratedByAthlete = {};
    wk.ratedByAthlete[id] = v;
  } else if (wk.ratedByAthlete && id in wk.ratedByAthlete) {
    delete wk.ratedByAthlete[id];
  }
}

/** Move the athlete's entry with a rating that moves to another slot key. */
export function moveRatingSource(wk: RatedWeek, from: string, to: string): void {
  if (!wk.ratedByAthlete || !(from in wk.ratedByAthlete)) return;
  wk.ratedByAthlete[to] = wk.ratedByAthlete[from];
  delete wk.ratedByAthlete[from];
}

/** The rating on slot `id` when the athlete entered it, else undefined. */
export function athleteRatedRpe(wk: RatedWeek | undefined, id: string): number | undefined {
  const v = wk?.rated?.[id];
  const mine = wk?.ratedByAthlete?.[id];
  return typeof v === 'number' && typeof mine === 'number' && v === mine ? v : undefined;
}
