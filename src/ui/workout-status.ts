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
  /** Rested or scaled by illness mode — a deliberate non-miss, like holiday. */
  isIllness: boolean;
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
  else if (f.isIllness) label = 'Illness';
  else if (f.isPast) label = 'Missed';
  else label = 'Upcoming';

  // Done wins the colour as well as the label. The label cascade already puts
  // done first, so a session completed *today* must read green "Logged"/"Done",
  // not terracotta — label and colour coming from different precedence orders
  // made "Logged" appear multi-coloured across the week.
  const color = f.isDone
    ? DONE_GREEN
    : f.isToday
      ? TODAY_ACCENT
      : (f.isPast && !f.isSkipped && !f.isIllness)
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

/**
 * Earliest weekday index (Mon=0..Sun=6) the plan actually existed for, within the
 * given week. Days before this were never schedulable, so they must not read
 * "Missed" on a freshly built / regenerated plan (e.g. onboard on a Wednesday →
 * Tuesday's session should not be "Missed"). Returns 0 when there is no
 * `planCreatedAt`, when it can't be parsed, or when creation predates this week's
 * start (the normal case for an established plan) — preserving legacy behaviour.
 *
 * Dates are parsed via component construction (local midnight) to match the rest
 * of this module; `new Date("YYYY-MM-DD")` would parse as UTC and skew the
 * same-day boundary in positive-UTC zones.
 */
export function firstTrackedDow(
  planStartDate: string | undefined,
  viewWeek: number,
  planCreatedAt: string | undefined,
): number {
  if (!planStartDate || !planCreatedAt) return 0;
  const [py, pm, pd] = planStartDate.split('-').map(Number);
  const [cy, cm, cd] = planCreatedAt.split('-').map(Number);
  if (!(py && pm && pd) || !(cy && cm && cd)) return 0;
  const wkStart = new Date(py, pm - 1, pd);
  wkStart.setDate(wkStart.getDate() + (viewWeek - 1) * 7);
  const created = new Date(cy, cm - 1, cd);
  created.setHours(0, 0, 0, 0);
  for (let d = 0; d < 7; d++) {
    const day = new Date(wkStart);
    day.setDate(day.getDate() + d);
    if (day >= created) return d;
  }
  return 7;
}

/**
 * Reduced partial first week: drop sessions scheduled before the plan existed.
 *
 * When a user onboards mid-week, week 1 is anchored to this Monday so
 * periodization stays calendar-aligned, but the days before they onboarded were
 * never schedulable. Rather than show empty/uncompletable cards or cram a full
 * week into the remaining days, we drop the pre-onboard days entirely: week 1
 * becomes a naturally-lighter block that starts today, full load resumes the
 * next Monday. A late-week (Sat/Sun) onboard simply leaves a chill 1–2 session
 * week 1 — the lead-in — with the first full week landing next Monday. Activities
 * the user already logged this week still credit to load (they flow in via the
 * activity matcher, independent of this list).
 *
 * No-op for established plans and Monday onboards. Applies to the onboarding
 * week whether it is the current week or has since rolled into the past: a
 * pre-onboard day was never schedulable, so it must never resurface as "Missed"
 * once week 1 is no longer current. `firstTrackedDow` is week-agnostic — it
 * returns 0 for every week except the one that contains `planCreatedAt` — so the
 * drop self-restricts to the onboarding week. The `currentWeek` parameter is
 * retained for signature compatibility with the status helpers.
 *
 * Keyed off `firstTrackedDow`, the single source for "first schedulable
 * weekday". Pass the resolved workout list for the given view week.
 */
export function dropPreOnboardSessions<T extends { dayOfWeek?: number }>(
  workouts: T[],
  planStartDate: string | undefined,
  viewWeek: number,
  _currentWeek: number,
  planCreatedAt: string | undefined,
): T[] {
  const ftd = firstTrackedDow(planStartDate, viewWeek, planCreatedAt);
  if (ftd <= 0) return workouts;
  return workouts.filter(w => (w.dayOfWeek ?? 0) >= ftd);
}

export interface WeekStatusContext {
  viewWeek: number;
  currentWeek: number;
  /** Mon = 0 .. Sun = 6 */
  actualToday: number;
  /**
   * Earliest weekday (Mon=0..Sun=6) the plan existed for in the current week.
   * Days before this are pre-creation and never count as Missed. 0 (or absent)
   * for past weeks / established plans / absent `planCreatedAt`.
   */
  firstTrackedDow?: number;
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
  planCreatedAt?: string,
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
  const ftd = viewWeek === currentWeek
    ? firstTrackedDow(planStartDate, viewWeek, planCreatedAt)
    : 0;
  return { viewWeek, currentWeek, actualToday, weekEnded, firstTrackedDow: ftd };
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
    isIllness: !!w.illnessMod,
    isAdded: String(id).startsWith('holiday-') || String(id).startsWith('adhoc-'),
    isReduced: w.status === 'reduced',
    isToday: isCurrentWeek && !ctx.weekEnded && dow === ctx.actualToday,
    isPast:
      ctx.viewWeek < ctx.currentWeek
      || (isCurrentWeek && ctx.weekEnded)
      || (isCurrentWeek && !ctx.weekEnded && dow >= (ctx.firstTrackedDow ?? 0) && dow < ctx.actualToday),
  });
}
