/**
 * Shared plan-card status chip — single source of truth for the
 * "Done / Logged / Missed / Today / Adjusted / Skipped / Replaced / Holiday /
 * Added" flag shown top-right of every workout card across running, triathlon
 * and HYROX.
 *
 * Running's plan-view computed this inline; triathlon and HYROX cards showed
 * nothing, so a missed or completed session looked identical to an upcoming
 * one. Lifting the logic here (detection-helper parity rule) keeps the three
 * modes from drifting: same labels, same colours, same precedence.
 *
 * Colours: Today = terracotta accent, Done/Logged = green, Missed = orange,
 * everything else = faint. Colour is reserved — only these three states carry
 * a non-neutral colour, matching the running original.
 */

export const TODAY_ACCENT = '#C4553A'; // warm terracotta, matches Load/Taper hero
const DONE_GREEN = '#34C759';
const MISSED_ORANGE = '#FF9500';

export interface WorkoutStatusFlags {
  isDone: boolean;
  /** Logged (matched from watch/Strava) vs Done (manually rated) */
  hasMatchedActivity: boolean;
  isSkipped: boolean;
  isReplaced: boolean;
  isHoliday: boolean;
  isAdded: boolean;
  isReduced: boolean;
  isToday: boolean;
  isPast: boolean;
}

export interface WorkoutStatusChip {
  label: string;
  color: string;
  /** false only for the trivial "Upcoming" state, which renders no chip */
  show: boolean;
}

/**
 * Pure label + colour resolution. Precedence matches running's original
 * cascade exactly: done state wins over today/past, replaced/holiday/added
 * over adjusted/skipped, today over missed.
 */
export function computeWorkoutStatus(f: WorkoutStatusFlags): WorkoutStatusChip {
  let label: string;
  if (f.isDone) label = f.hasMatchedActivity ? 'Logged' : 'Done';
  else if (f.isReplaced) label = 'Replaced';
  else if (f.isHoliday) label = 'Holiday';
  else if (f.isAdded) label = 'Added';
  else if (f.isReduced) label = 'Adjusted';
  else if (f.isSkipped) label = 'Skipped';
  else if (f.isToday) label = 'Today';
  else if (f.isPast) label = 'Missed';
  else label = 'Upcoming';

  const color = f.isToday
    ? TODAY_ACCENT
    : f.isDone
      ? DONE_GREEN
      : (f.isPast && !f.isDone && !f.isSkipped)
        ? MISSED_ORANGE
        : 'var(--c-faint)';

  return { label, color, show: label !== 'Upcoming' };
}

/** Render the canonical chip span. Empty string for the trivial state. */
export function renderWorkoutStatusChip(chip: WorkoutStatusChip): string {
  return chip.show
    ? `<span style="font-size:10px;font-weight:600;color:${chip.color}">${chip.label}</span>`
    : '';
}

export interface WeekStatusContext {
  viewWeek: number;
  currentWeek: number;
  /** Mon = 0 .. Sun = 6 */
  actualToday: number;
  /**
   * True only when `planStartDate` proves the *current* week's calendar range
   * has fully elapsed (a stale week that was never wrapped up). A missing or
   * unreadable `planStartDate` leaves this false — the current week is current
   * by definition once the plan anchor has advanced, so today's own session is
   * never wrongly flagged Missed.
   */
  weekEnded: boolean;
}

/**
 * Per-week context needed to derive the today/past flags.
 *
 * For the current week, today/past come from the weekday alone (`actualToday`):
 * the week containing `s.w` is current by definition after `advanceWeekToToday`,
 * so today's session must read "Today", not "Missed". `planStartDate` is used
 * only to detect a stale week whose last calendar day has already passed
 * (`weekEnded`); when it is absent or unreadable we do NOT blanket-mark the week
 * as past — that is what previously marked Saturday's session Missed on Saturday.
 *
 * planStartDate is parsed as local midnight via component construction —
 * `new Date("YYYY-MM-DD")` parses as UTC midnight and skews same-day checks in
 * positive-UTC zones.
 */
export function computeWeekStatusContext(
  planStartDate: string | undefined,
  viewWeek: number,
  currentWeek: number,
): WeekStatusContext {
  const jsDay = new Date().getDay();
  const actualToday = jsDay === 0 ? 6 : jsDay - 1;
  let weekEnded = false;
  if (viewWeek === currentWeek && planStartDate) {
    const [y, m, d] = planStartDate.split('-').map(Number);
    if (y && m && d) {
      const wkStart = new Date(y, m - 1, d);
      wkStart.setDate(wkStart.getDate() + (viewWeek - 1) * 7);
      const wkEnd = new Date(wkStart);
      wkEnd.setDate(wkEnd.getDate() + 6);
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      weekEnded = now > wkEnd;
    }
  }
  return { viewWeek, currentWeek, actualToday, weekEnded };
}

/**
 * Derive the status chip for a single workout from the week object + context.
 * Used by triathlon and HYROX cards, which (unlike running) don't pre-compute
 * the done/today/past booleans inline.
 *
 * Done sources mirror running: a `'completed'` status, a matched activity, or a
 * positive numeric rating all count. The matched activity is looked up by the
 * workout's `matchedActivityId` first, then by slot id (running's direct path).
 */
export function deriveWorkoutStatus(w: any, wk: any, ctx: WeekStatusContext): WorkoutStatusChip {
  const id = w.id || w.n;
  const actuals = (wk?.garminActuals ?? {}) as Record<string, any>;
  const rated = (wk?.rated ?? {}) as Record<string, number | 'skip'>;
  const matched = (w.matchedActivityId && actuals[w.matchedActivityId]) || actuals[id] || null;
  const ratingVal = rated[id];

  const isCurrentWeek = ctx.viewWeek === ctx.currentWeek;
  const dow = w.dayOfWeek ?? -1;

  return computeWorkoutStatus({
    isDone: w.status === 'completed' || !!matched || (typeof ratingVal === 'number' && ratingVal > 0),
    hasMatchedActivity: !!matched,
    isSkipped: ratingVal === 'skip' || w.status === 'skip' || w.status === 'skipped',
    isReplaced: w.status === 'replaced',
    isHoliday: w.status === 'holiday',
    isAdded: String(id).startsWith('holiday-') || String(id).startsWith('adhoc-'),
    isReduced: w.status === 'reduced',
    isToday: isCurrentWeek && !ctx.weekEnded && dow === ctx.actualToday,
    isPast:
      ctx.viewWeek < ctx.currentWeek
      || (isCurrentWeek && ctx.weekEnded)
      || (isCurrentWeek && !ctx.weekEnded && dow >= 0 && dow < ctx.actualToday),
  });
}
