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
  hrEffort: 'overcooked' | 'on-target' | 'undercooked' | null;
  load: 'high-over' | 'over' | 'on-plan' | 'under' | null;
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
  rpeScore: number | null,
  hrEffortScore: number | null,
  tssPct: number | null,
  ctlDelta: number | null,
  avgHrDrift: number | null,
): WeekSignals {
  // RPE: perceived effort deviation from expected (positive = harder than planned)
  const rpe: WeekSignals['rpe'] =
    rpeScore == null ? null :
    rpeScore > 1.0 ? 'hard' :
    rpeScore < -1.0 ? 'easy' :
    'on-target';

  // HR effort: objective effort from HR data (1.0 = on target, >1.0 = overcooked)
  const hrEffort: WeekSignals['hrEffort'] =
    hrEffortScore == null ? null :
    hrEffortScore > 1.1 ? 'overcooked' :
    hrEffortScore < 0.85 ? 'undercooked' :
    'on-target';

  // tssPct is a delta from plan: +10 means 10% over, -25 means 25% under
  const load: WeekSignals['load'] =
    tssPct == null ? null :
    tssPct > 30 ? 'high-over' :
    tssPct > 10 ? 'over' :
    tssPct >= -25 ? 'on-plan' :
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

  return { rpe, hrEffort, load, fitness, hrDrift };
}

export function getSignalPills(signals: WeekSignals): SignalPill[] {
  const pills: SignalPill[] = [];

  // Perceived effort — from user RPE ratings vs expected
  if (signals.rpe != null) {
    const map = {
      hard: { value: 'Harder than expected', color: 'red' },
      'on-target': { value: 'As expected', color: 'green' },
      easy: { value: 'Easier than expected', color: 'green' },
    } as const;
    pills.push({ label: 'Perceived effort', ...map[signals.rpe] });
  } else {
    pills.push({ label: 'Perceived effort', value: '—', color: 'neutral' });
  }

  // HR effort — objective effort from heart rate data
  if (signals.hrEffort != null) {
    const map = {
      overcooked: { value: 'Above target zone', color: 'red' },
      'on-target': { value: 'In target zone', color: 'green' },
      undercooked: { value: 'Below target zone', color: 'green' },
    } as const;
    pills.push({ label: 'Heart rate effort', ...map[signals.hrEffort] });
  } else {
    pills.push({ label: 'Heart rate effort', value: '—', color: 'neutral' });
  }

  // Training volume — TSS vs plan
  if (signals.load != null) {
    const map = {
      'high-over': { value: 'Well above plan', color: 'red' },
      over: { value: 'Above plan', color: 'amber' },
      'on-plan': { value: 'On plan', color: 'green' },
      under: { value: 'Below plan', color: 'amber' },
    } as const;
    pills.push({ label: 'Training volume', ...map[signals.load] });
  } else {
    pills.push({ label: 'Training volume', value: '—', color: 'neutral' });
  }

  // Running load — CTL delta week-over-week
  if (signals.fitness != null) {
    const map = {
      up: { value: 'Improving', color: 'green' },
      flat: { value: 'Steady', color: 'neutral' },
      down: { value: 'Declining', color: 'red' },
    } as const;
    pills.push({ label: 'Running load', ...map[signals.fitness] });
  } else {
    pills.push({ label: 'Running load', value: '—', color: 'neutral' });
  }

  // HR during sessions — average HR drift across runs
  if (signals.hrDrift != null) {
    const map = {
      efficient: { value: 'Stable', color: 'green' },
      moderate: { value: 'Moderate rise', color: 'neutral' },
      stressed: { value: 'Significant rise', color: 'red' },
    } as const;
    pills.push({ label: 'HR during sessions', ...map[signals.hrDrift] });
  } else {
    pills.push({ label: 'HR during sessions', value: '—', color: 'neutral' });
  }

  return pills;
}

export function getCoachCopy(signals: WeekSignals, phase?: string): string | null {
  const { rpe, hrEffort, load, fitness, hrDrift } = signals;
  const canPushMore = load === 'under' && phase !== 'taper';

  if (rpe == null && load == null) return null;

  let copy = '';

  const isOver = load === 'over' || load === 'high-over';

  // Primary: RPE × Load matrix
  if (rpe === 'hard' && isOver) {
    copy = "Last week was hard and high volume. This week backs off to let your body absorb the work.";
  } else if (rpe === 'hard' && load === 'on-plan') {
    copy = "Runs felt tougher than planned last week, though you hit your load target. Paces may be slightly ambitious. This week adjusts based on your effort feedback.";
  } else if (rpe === 'hard' && load === 'under') {
    copy = "Last week's effort was high but volume came in below target. An unusual pattern. Possibly one tough session pulling up the average. Worth keeping an eye on.";
  } else if (rpe === 'easy' && isOver) {
    copy = "Last week was high volume and felt controlled. A strong sign your fitness is building.";
  } else if (rpe === 'easy' && load === 'on-plan') {
    copy = "Last week was solid. Effort was well within range and load was on target. Fitness is building steadily.";
  } else if (rpe === 'easy' && load === 'under') {
    copy = "Last week was light and effort was low. Easy mileage is always welcome if energy allows."
      + (canPushMore ? " If you're feeling fresh, this week is a good opportunity to add a little more." : "");
  } else if (rpe === 'on-target' && isOver) {
    copy = "Last week's load came in above plan but effort stayed appropriate. Your fitness is handling the volume well. This week eases back slightly.";
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
    copy = isOver
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
    additions.push("Running efficiency is improving. Paces will sharpen slightly this week.");
  } else if (fitness === 'down' && rpe === 'hard') {
    additions.push("Combined with the effort score, a recovery week may be due soon.");
  }

  // RPE vs HR divergence — a meaningful coaching signal
  if (rpe === 'hard' && hrEffort === 'on-target') {
    additions.push("Runs felt hard but HR stayed in zone. Possible fatigue, stress, or heat, not a fitness issue.");
  } else if (rpe === 'easy' && hrEffort === 'overcooked') {
    additions.push("Runs felt controlled but HR ran high. Possible dehydration, poor sleep, or early signs of overreaching.");
  }

  if (hrDrift === 'stressed' && rpe === 'hard') {
    additions.push("HR drift was high. Your aerobic system was under significant stress.");
  } else if (hrDrift === 'efficient' && (rpe === 'easy' || rpe === 'on-target')) {
    additions.push("Low HR drift. Your aerobic base is strengthening.");
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

  return `This is a draft ${phaseDesc} week. Paces are calibrated to your current fitness (VDOT ${Math.round(vdot * 10) / 10}). Volume is set from your recent training load. We track how much you've been doing to avoid ramping too fast. Workout types follow your ${phase} block structure.${raceNote} Distances are estimates; everything locks in as your training progresses.`;
}
