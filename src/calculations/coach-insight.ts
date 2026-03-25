/**
 * Coach Insight — Week signals + copy for Week Overview and debrief.
 *
 * Signals computed from real data: RPE (effortScore), Load (tssPct),
 * Fitness direction (ctlDelta), Aerobic efficiency (HR drift).
 *
 * Coach copy: decision tree on RPE × Load with secondary modifiers.
 * Novel combinations or insufficient data return null — UI shows nothing.
 */

export interface WeekSignals {
  rpe: 'hard' | 'on-target' | 'easy' | null;
  load: 'over' | 'on-plan' | 'under' | null;
  fitness: 'up' | 'flat' | 'down' | null;
  hrDrift: 'efficient' | 'moderate' | 'stressed' | null;
}

export interface SignalPill {
  label: string;
  value: string;
  color: 'green' | 'amber' | 'red' | 'neutral';
}

export const PILL_COLORS: Record<string, { bg: string; text: string }> = {
  green:   { bg: 'rgba(34,197,94,0.12)',  text: '#15803D' },
  amber:   { bg: 'rgba(245,158,11,0.12)', text: '#B45309' },
  red:     { bg: 'rgba(239,68,68,0.12)',  text: '#DC2626' },
  neutral: { bg: 'rgba(0,0,0,0.06)',      text: 'var(--c-muted)' },
};

export function computeWeekSignals(
  effortScore: number | null,
  tssPct: number | null,
  ctlDelta: number | null,
  avgHrDrift: number | null,
): WeekSignals {
  const rpe: WeekSignals['rpe'] =
    effortScore == null ? null :
    effortScore > 1.0 ? 'hard' :
    effortScore < -1.0 ? 'easy' :
    'on-target';

  const load: WeekSignals['load'] =
    tssPct == null ? null :
    tssPct > 110 ? 'over' :
    tssPct >= 75 ? 'on-plan' :
    'under';

  const fitness: WeekSignals['fitness'] =
    ctlDelta == null ? null :
    ctlDelta > 0.5 ? 'up' :
    ctlDelta < -0.5 ? 'down' :
    'flat';

  const hrDrift: WeekSignals['hrDrift'] =
    avgHrDrift == null ? null :
    avgHrDrift < 0.04 ? 'efficient' :
    avgHrDrift < 0.08 ? 'moderate' :
    'stressed';

  return { rpe, load, fitness, hrDrift };
}

export function getSignalPills(signals: WeekSignals): SignalPill[] {
  const pills: SignalPill[] = [];

  if (signals.rpe != null) {
    const map = {
      hard: { value: 'Hard', color: 'red' },
      'on-target': { value: 'On target', color: 'green' },
      easy: { value: 'Easy', color: 'green' },
    } as const;
    pills.push({ label: 'Effort', ...map[signals.rpe] });
  }

  if (signals.load != null) {
    const map = {
      over: { value: 'Above plan', color: 'amber' },
      'on-plan': { value: 'On plan', color: 'green' },
      under: { value: 'Below plan', color: 'amber' },
    } as const;
    pills.push({ label: 'Load', ...map[signals.load] });
  }

  if (signals.fitness != null) {
    const map = {
      up: { value: '↑ Rising', color: 'green' },
      flat: { value: '→ Steady', color: 'neutral' },
      down: { value: '↓ Dipping', color: 'red' },
    } as const;
    pills.push({ label: 'Fitness', ...map[signals.fitness] });
  }

  if (signals.hrDrift != null) {
    const map = {
      efficient: { value: 'Efficient', color: 'green' },
      moderate: { value: 'Moderate', color: 'neutral' },
      stressed: { value: 'Stressed', color: 'red' },
    } as const;
    pills.push({ label: 'Aerobic', ...map[signals.hrDrift] });
  }

  return pills;
}

export function getCoachCopy(signals: WeekSignals, phase?: string): string | null {
  const { rpe, load, fitness, hrDrift } = signals;
  const canPushMore = load === 'under' && phase !== 'taper';

  if (rpe == null && load == null) return null;

  let copy = '';

  // Primary: RPE × Load matrix
  if (rpe === 'hard' && load === 'over') {
    copy = "Last week was hard and high volume — a taxing combination. This week backs off to let your body absorb the work.";
  } else if (rpe === 'hard' && load === 'on-plan') {
    copy = "Runs felt tougher than planned last week, though you hit your load target. Paces may be slightly ambitious — this week adjusts based on your effort feedback.";
  } else if (rpe === 'hard' && load === 'under') {
    copy = "Last week's effort was high but volume came in below target — an unusual pattern. Possibly one tough session pulling up the average. Worth keeping an eye on.";
  } else if (rpe === 'easy' && load === 'over') {
    copy = "Last week was high volume and felt controlled — a strong sign your fitness is building. Great week.";
  } else if (rpe === 'easy' && load === 'on-plan') {
    copy = "Last week was solid. Effort was well within range and load was on target. Fitness is building steadily.";
  } else if (rpe === 'easy' && load === 'under') {
    copy = "Last week was light and effort was low. That's fine — easy mileage is always welcome if energy allows."
      + (canPushMore ? " If you're feeling fresh, this week is a good opportunity to add a little more." : "");
  } else if (rpe === 'on-target' && load === 'over') {
    copy = "Last week's load came in above plan but effort stayed appropriate — your fitness is handling the volume well. This week eases back slightly.";
  } else if (rpe === 'on-target' && load === 'on-plan') {
    copy = "Last week tracked to plan. Consistent, well-executed.";
  } else if (rpe === 'on-target' && load === 'under') {
    copy = "Slightly under on load last week. No alarm."
      + (canPushMore ? " If you're feeling good, this week is a chance to make it up." : " But if this becomes a pattern it may slow progress.");
  } else if (rpe != null) {
    // Only RPE known
    copy = rpe === 'hard'
      ? "Runs felt harder than planned last week. Paces have been adjusted for this week."
      : rpe === 'easy'
      ? "Runs felt well within your range last week. Fitness is responding well."
      : "Effort was right on target last week.";
  } else if (load != null) {
    // Only load known
    copy = load === 'over'
      ? "Last week's load came in above plan. This week is dialled back slightly."
      : load === 'under'
      ? "Last week's load came in below plan." + (canPushMore ? " If you're feeling good, this week is a chance to make it up." : " This week holds steady.")
      : "Last week's load was right on plan.";
  } else {
    return null;
  }

  // Secondary modifiers
  const additions: string[] = [];

  if (fitness === 'up' && rpe === 'easy') {
    additions.push("Running efficiency is improving — paces will sharpen slightly this week.");
  } else if (fitness === 'down' && rpe === 'hard') {
    additions.push("Combined with the effort score, a recovery week may be due soon.");
  }

  if (hrDrift === 'stressed' && rpe === 'hard') {
    additions.push("HR drift was high — your aerobic system was under significant stress.");
  } else if (hrDrift === 'efficient' && (rpe === 'easy' || rpe === 'on-target')) {
    additions.push("Low HR drift — your aerobic base is strengthening.");
  }

  if (additions.length > 0) copy += ' ' + additions.join(' ');

  return copy;
}

export function getFutureWeekPills(
  vdot: number,
  phase: string,
  acwrStatus: string | null,
  weeksToRace: number | null,
  hasRace: boolean,
): SignalPill[] {
  const pills: SignalPill[] = [];

  pills.push({ label: 'Fitness', value: `VDOT ${Math.round(vdot * 10) / 10}`, color: 'neutral' });

  const phaseMap: Record<string, { value: string; color: SignalPill['color'] }> = {
    base:  { value: 'Base block',  color: 'neutral' },
    build: { value: 'Build block', color: 'amber' },
    peak:  { value: 'Peak block',  color: 'red' },
    taper: { value: 'Taper',       color: 'green' },
  };
  if (phaseMap[phase]) pills.push({ label: 'Phase', ...phaseMap[phase] });

  if (acwrStatus && acwrStatus !== 'unknown') {
    const acwrMap: Record<string, { value: string; color: SignalPill['color'] }> = {
      safe:    { value: 'Load: Safe',    color: 'green' },
      caution: { value: 'Load: Caution', color: 'amber' },
      high:    { value: 'Load: High',    color: 'red' },
    };
    if (acwrMap[acwrStatus]) pills.push({ label: 'Training', ...acwrMap[acwrStatus] });
  }

  if (hasRace && weeksToRace != null && weeksToRace <= 8) {
    pills.push({
      label: 'Race',
      value: `${weeksToRace}w to go`,
      color: weeksToRace <= 2 ? 'red' : weeksToRace <= 4 ? 'amber' : 'neutral',
    });
  }

  return pills;
}

export function getFutureWeekCopy(
  phase: string,
  weekNum: number,
  totalWeeks: number,
  vdot: number,
  hasRace: boolean,
): string {
  const weeksToRace = totalWeeks - weekNum + 1;

  const phaseDescs: Record<string, string> = {
    base:  "base building",
    build: "intensity building",
    peak:  "peak training",
    taper: "race taper",
  };
  const phaseDesc = phaseDescs[phase] ?? "training";

  const raceNote = hasRace && weeksToRace <= 8
    ? ` With ${weeksToRace} week${weeksToRace === 1 ? '' : 's'} to race day, volume is managed carefully.`
    : '';

  return `This is a draft ${phaseDesc} week. Paces are calibrated to your current fitness (VDOT ${Math.round(vdot * 10) / 10}). Volume is set from your recent training load — we track how much you've been doing to avoid ramping too fast. Workout types follow your ${phase} block structure.${raceNote} Distances are estimates; everything locks in as your training progresses.`;
}
