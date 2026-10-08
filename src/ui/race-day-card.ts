/**
 * Race-day card (visual QA 2026-10-08). The race day of a race plan read
 * "Rest" in every mode, with nothing saying the race is that day. The Plan tab
 * of every mode (running, triathlon including cycling, HYROX) shows this card
 * on race day, and Home shows it as today's card on race day.
 *
 * Display only. The card is not a workout: it is never added to a week's
 * workout list, carries no planned load, and takes no part in matching, load
 * targets or completion. The race day comes from the same race date and plan
 * start the generators place race week and drop sessions from (SCIENCE_LOG
 * §CW: runningRaceDateISO for running, triConfig.raceDate for triathlon and
 * cycling, hyroxConfig.raceDate for HYROX; raceWeekLayout for the day).
 *
 * Visual pattern: the plan workout card (plan-view buildWorkoutCards,
 * renderTriWorkoutCard): white card, 14px radius, the plan-card shadow, a
 * small muted top row, a 15px/600 title, a 13px muted detail line. No badge,
 * no icon, no tinted background. Today's accent (TODAY_ACCENT, the one
 * non-neutral colour) marks it only when race day is today, as on a workout
 * card.
 */

import type { SimulatorState } from '@/types/state';
import { raceWeekLayout, runningRaceDateISO } from '@/workouts/race-week-layout';
import { calendarDayNumber, localDateKey } from '@/utils/local-date';
import { formatKm, type UnitPref } from '@/utils/format';
import { rdKm } from '@/calculations/vdot';
import { getTriDistanceLabel, RACE_LEG_DISTANCES } from '@/constants/triathlon-constants';
import { getCyclingEventLabel } from '@/calculations/cycling-mode';
import { getTriathlonById } from '@/data/triathlons';
import { getHyroxEventById } from '@/data/hyrox-events';
import { formatRaceDate } from '@/data/marathons';
import { TODAY_ACCENT } from './workout-status';

export interface RaceDayInfo {
  /** Race day, YYYY-MM-DD (local calendar). */
  dateISO: string;
  /** Plan week holding race day, 1-based. */
  week: number;
  /** Weekday of race day in the plan's day indexing, 0 = Monday ... 6 = Sunday. */
  dayOfWeek: number;
  /** The race name when known, else the event label ("Marathon", "Hamburg 70.3"). */
  title: string;
  /** Distance and date, e.g. "42.2 km · 8 Nov 2026". */
  detail: string;
}

type RaceDayState = Pick<SimulatorState,
  'eventType' | 'trackOnly' | 'continuousMode' | 'planStartDate' | 'tw' | 'rd' | 'unitPref'
  | 'selectedMarathon' | 'onboarding' | 'triConfig' | 'hyroxConfig'>;

const RUN_DISTANCE_LABEL: Record<string, string> = {
  '5k': '5K', '10k': '10K', half: 'Half marathon', marathon: 'Marathon',
};

const HYROX_FORMAT_LABEL: Record<string, string> = {
  open_singles: 'Open Singles', open_doubles: 'Open Doubles',
  pro_singles: 'Pro Singles', pro_doubles: 'Pro Doubles',
};

function validISO(d: string | null | undefined): string | null {
  if (!d) return null;
  const day = d.slice(0, 10);
  return Number.isFinite(calendarDayNumber(day)) ? day : null;
}

/**
 * The race date of a race plan in any mode, the one each generator places race
 * week from: running runningRaceDateISO, triathlon and cycling
 * triConfig.raceDate, HYROX hyroxConfig.raceDate. Null for continuous and
 * Just-Track plans and without a date.
 */
export function planRaceDateISO(s: Partial<RaceDayState>): string | null {
  if (s.trackOnly || s.continuousMode) return null;
  if (s.eventType === 'triathlon') return validISO(s.triConfig?.raceDate);
  if (s.eventType === 'hyrox') return validISO(s.hyroxConfig?.raceDate);
  return runningRaceDateISO(s);
}

/** A distance for display: whole kilometres without decimals, sub-kilometre swims to the metre. */
function fmtDistance(km: number, pref: UnitPref): string {
  if (pref === 'mi') return formatKm(km, 'mi', 1);
  if (Number.isInteger(km)) return formatKm(km, 'km', 0);
  return formatKm(km, 'km', km < 1 && !Number.isInteger(km * 10) ? 2 : 1);
}

function titleAndDistance(s: Partial<RaceDayState>): { title: string; parts: string[] } {
  const pref: UnitPref = s.unitPref ?? 'km';
  if (s.eventType === 'triathlon') {
    const cycling = getCyclingEventLabel(s as Pick<SimulatorState, 'onboarding' | 'triConfig'>);
    if (cycling) return { title: cycling, parts: [] };
    const distance = s.triConfig?.distance ?? '70.3';
    const label = getTriDistanceLabel(distance);
    const event = getTriathlonById(s.onboarding?.selectedTriathlonId ?? '');
    const legs = RACE_LEG_DISTANCES[distance];
    const legText = legs
      ? `${fmtDistance(legs.swimM / 1000, pref)} swim, ${fmtDistance(legs.bikeKm, pref)} bike, ${fmtDistance(legs.runKm, pref)} run`
      : '';
    // The tri plan header's event label: city and distance label.
    const title = event?.city ? `${event.city} ${label}` : `${label} triathlon`;
    return { title, parts: legText ? [legText] : [] };
  }
  if (s.eventType === 'hyrox') {
    const city = s.hyroxConfig?.raceEventId ? getHyroxEventById(s.hyroxConfig.raceEventId)?.city : undefined;
    const format = HYROX_FORMAT_LABEL[s.hyroxConfig?.format ?? 'open_singles'] ?? 'Open Singles';
    return { title: city ? `${city} HYROX` : 'HYROX', parts: [format] };
  }
  const label = RUN_DISTANCE_LABEL[s.rd ?? 'marathon'] ?? 'Race';
  const name = (s.selectedMarathon?.name ?? s.onboarding?.selectedRace?.name ?? '').toString().trim();
  const km = fmtDistance(rdKm(s.rd ?? 'marathon'), pref);
  return name ? { title: name, parts: [label, km] } : { title: label, parts: [km] };
}

/** Race day of the plan, or null when the plan has no race date or race day falls outside its weeks. */
export function raceDayInfo(s: Partial<RaceDayState>): RaceDayInfo | null {
  const dateISO = planRaceDateISO(s);
  if (!dateISO || !s.planStartDate) return null;
  const layout = raceWeekLayout(s.planStartDate.slice(0, 10), dateISO);
  if (!layout) return null;
  const week = Math.floor(layout.raceDayIndex / 7) + 1;
  if (!(s.tw && week <= s.tw)) return null;
  const { title, parts } = titleAndDistance(s);
  return { dateISO, week, dayOfWeek: layout.raceDayOfWeek, title, detail: [...parts, formatRaceDate(dateISO)].join(' · ') };
}

/** Race day when it falls in plan week `viewWeek`, else null. */
export function raceDayInWeek(s: Partial<RaceDayState>, viewWeek: number): RaceDayInfo | null {
  const info = raceDayInfo(s);
  return info && info.week === viewWeek ? info : null;
}

/** Race day when it is today (local calendar), else null. */
export function raceDayToday(s: Partial<RaceDayState>, todayKey: string = localDateKey(new Date())): RaceDayInfo | null {
  const info = raceDayInfo(s);
  return info && info.dateISO === todayKey ? info : null;
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/** The Plan tab's race-day card (every mode). */
export function renderRaceDayCard(info: RaceDayInfo, todayKey: string = localDateKey(new Date())): string {
  const isToday = info.dateISO === todayKey;
  return `
    <div class="race-day-card" data-race-day-card="${info.dateISO}" style="
      background:#fff;
      border-radius:14px;
      padding:14px 16px;
      margin-bottom:8px;
      box-shadow:0 1px 2px rgba(0,0,0,0.04),0 4px 14px rgba(0,0,0,0.05);
      ${isToday ? `border-left:3px solid ${TODAY_ACCENT};` : ''}
    ">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:11px;font-weight:500;color:var(--c-muted)">Race day</span>
        <span style="flex:1"></span>
        ${isToday ? `<span style="font-size:10px;font-weight:600;color:${TODAY_ACCENT}">Today</span>` : ''}
      </div>
      <div style="font-size:15px;font-weight:600;color:#0F172A;margin-bottom:4px;letter-spacing:-0.01em">${esc(info.title)}</div>
      <div style="font-size:13px;color:var(--c-muted);line-height:1.5">${esc(info.detail)}</div>
    </div>
  `;
}

/**
 * The race-day card for weekday `dayOfWeek` of plan week `viewWeek`, or '' when
 * race day is another day. For the triathlon and HYROX day lists (renderDay).
 */
export function raceDayCardHtml(s: Partial<RaceDayState>, viewWeek: number, dayOfWeek: number): string {
  const info = raceDayInWeek(s, viewWeek);
  return info && info.dayOfWeek === dayOfWeek ? renderRaceDayCard(info) : '';
}
