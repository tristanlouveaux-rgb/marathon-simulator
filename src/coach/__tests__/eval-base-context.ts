/**
 * Minimal but realistic coachContexts used as the base for eval scenarios.
 * Scenarios override fields as needed. Mirrors the shape emitted by
 * `coach-context-builder.ts` so the system prompt's section descriptions line up.
 *
 * Exports:
 * - baseTriContext. Triathlon mode (default for most scenarios)
 * - baseRunningContext. Marathon plan mode
 * - baseHyroxContext. HYROX race prep mode
 */

export const baseTriContext = {
  mode: 'triathlon',
  today: '2026-05-14',
  athlete: {
    race_distance: '70.3',
    race_date: '2026-08-15',
    weeks_to_race: 13,
    week: 7,
    total_weeks: 20,
    phase: 'build',
    tier: 'performance',
    hours_per_week: 10,
  },
  benchmarks: {
    swim: { css_sec_per_100m: 95, css_display: '1:35 /100m', confidence: 'medium', source: 'derived' },
    bike: { ftp_watts: 250, ftp_confidence: 'medium', ftp_source: 'derived', lthr: 165, has_power_meter: true },
    run:  { vdot: 48, lt_pace: '4:30 min/km', lt_confidence: 'medium' },
  },
  disciplines: {
    swim: { ctl: 2.9, atl: 3.1, tsb: -0.2, readiness: 'good' },
    bike: { ctl: 5.2, atl: 5.5, tsb: -0.3, readiness: 'good' },
    run:  { ctl: 10.3, atl: 9.8, tsb: 0.5, readiness: 'good' },
    combined_ctl: 18.4,
    overall_readiness: 'good',
    binding_signal: 'Fitness building steadily.',
  },
  fitness_history_8w: [],
  race_prediction: {
    total: '5h 12m',
    swim: '34m',
    bike: '2h 35m',
    run: '1h 55m',
    confidence_range: ['5h 02m', '5h 25m'],
    current_fitness_total: '5h 28m',
    limiting_factor: 'run',
  },
  readiness: {
    score: 72,
    label: 'Good',
    stance: 'normal',
    primary_message: 'Solid week ahead. Maintain the plan.',
    tsb_daily: 0.5,
    acwr: 0.95,
    acwr_status: 'safe',
    hrv_ms: 58,
    hrv_pct_vs_baseline: 2,
    sleep_last_night: 75,
    sleep_7d_avg: 72,
    sleep_debt_hours: -0.5,
    today_feeling: null,
    blockers: [],
  },
  fitness_trend: {
    tss_8_weeks: [320, 340, 360, 380, 410, 425, 440, 450],
    week_tss: 220,
    planned_week_tss: 450,
    week_tss_pct: 49,
  },
  memory_facts: [],
  injury: null,
  illness: null,
  this_week_plan: [
    {
      name: 'Swim technique', type: 'swim_technique', discipline: 'swim',
      description: '3300m total. 200m WU. Drills: 6×25m fist swim + 4×50m 6-kick switch. Main: 8×75m easy pull @ 2:10/100m. 200m CD.',
      day: 'Tuesday', workout_index: 0, est_duration_min: 66, rpe: 3, status: 'planned',
    },
    {
      name: 'Bike threshold', type: 'bike_threshold', discipline: 'bike',
      description: '90 min total. 15 min WU. 3×10 min @ 240W with 5 min recoveries. 15 min CD.',
      day: 'Wednesday', workout_index: 0, est_duration_min: 90, rpe: 7, status: 'planned',
    },
    {
      name: 'Easy run', type: 'easy_run', discipline: 'run',
      description: '8km easy at 5:15/km, Z2 only.',
      day: 'Thursday', workout_index: 0, est_duration_min: 42, rpe: 3, status: 'planned',
    },
    {
      name: 'Long ride', type: 'bike_endurance', discipline: 'bike',
      description: '3h endurance. 2h Z2, 1h Z3 sustained.',
      day: 'Saturday', workout_index: 0, est_duration_min: 180, rpe: 5, status: 'planned',
    },
    {
      name: 'Long run', type: 'long_run', discipline: 'run',
      description: '18km steady. 14km Z2, 4km MP. Practise fuelling.',
      day: 'Sunday', workout_index: 0, est_duration_min: 95, rpe: 5, status: 'planned',
    },
  ],
  plan_skeleton: [
    { week: 5, phase: 'base', planned_tss: 380, planned_hours: 9, marker: 'past' },
    { week: 6, phase: 'base', planned_tss: 410, planned_hours: 9.5, marker: 'past' },
    { week: 7, phase: 'build', planned_tss: 450, planned_hours: 10, marker: 'current' },
    { week: 8, phase: 'build', planned_tss: 475, planned_hours: 10, marker: 'future' },
    { week: 9, phase: 'build', planned_tss: 495, planned_hours: 10.5, marker: 'future' },
    { week: 19, phase: 'taper', planned_tss: 220, planned_hours: 5, marker: 'future' },
    { week: 20, phase: 'race', planned_tss: 80, planned_hours: 3, marker: 'future' },
  ],
  adaptation_log: {
    last_notified_markers: { ftp_w: 248, css_sec_per_100m: 97, vdot: 47 },
    plan_reset_count: 0,
  },
  recent_activities: [
    {
      date: '2026-05-13', type: 'Run', matched_workout: 'Easy run', distance_km: 8.1, duration_min: 42,
      avg_pace: '5:11 min/km', avg_pace_sec_km: 311, avg_hr: 142, hr_drift_pct: 1.2, hr_effort_score: 0.98,
      pace_adherence: 0.99, elevation_gain_m: 45, avg_power_w: null, normalized_power_w: null, km_splits: null,
    },
  ],
};

// ─── Running mode ────────────────────────────────────────────────────────────

export const baseRunningContext = {
  mode: 'running',
  today: '2026-05-14',
  athlete: {
    vdot: 48,
    lt_pace: '4:30 min/km',
    lt_confidence: 'medium',
    vo2max: 56,
    race: 'marathon',
    goal_time: '3h 15m',
    current_fitness_time: '3h 22m',
    tier: 'performance',
    runner_type: 'balanced',
    pbs: { '5k': '20m 15s', '10k': '42m 30s', 'half': '1h 32m' },
    paces: { easy: '5:15 min/km', marathon: '4:35 min/km', threshold: '4:00 min/km', vo2max: '3:45 min/km' },
    week: 8,
    total_weeks: 16,
    phase: 'build',
    weeks_to_race: 8,
  },
  readiness: {
    score: 74, label: 'Good', stance: 'normal',
    primary_message: 'Maintain the plan.',
    tsb_daily: 0.8, tsb_zone: 'neutral',
    acwr: 0.98, acwr_status: 'safe',
    hrv_ms: 60, hrv_pct_vs_baseline: 3,
    sleep_last_night: 78, sleep_7d_avg: 75, sleep_debt_hours: -0.3,
    today_feeling: null, blockers: [],
  },
  fitness_trend: {
    tss_8_weeks: [280, 305, 330, 360, 390, 420, 445, 460],
    km_8_weeks: [42, 45, 48, 52, 56, 60, 64, 65],
    ctl_daily_equiv: 65,
    ctl_trend: 'rising',
    week_tss: 220, planned_week_tss: 460, week_tss_pct: 48,
    rpe_signal: 0.1, hr_drift_signal: 1.5,
  },
  priorities: null,
  memory_facts: [],
  ai_modifications: [],
  injury: null,
  illness: null,
  this_week_plan: [
    { name: 'Easy run', type: 'easy', description: '8km easy at 5:15/km.', day: 'Monday', workout_index: 0, target_pace: '5:15 min/km', est_duration_min: 42, rpe: 3, status: 'planned' },
    { name: 'Tempo run', type: 'tempo', description: '14km with 8km @ MP.', day: 'Tuesday', workout_index: 0, target_pace: '4:35 min/km', est_duration_min: 70, rpe: 6, status: 'planned' },
    { name: 'Easy run', type: 'easy', description: '8km easy.', day: 'Wednesday', workout_index: 0, target_pace: '5:15 min/km', est_duration_min: 42, rpe: 3, status: 'planned' },
    { name: 'VO2 intervals', type: 'vo2', description: '5x1km @ 3:45/km with 90s recoveries.', day: 'Thursday', workout_index: 0, target_pace: '3:45 min/km', est_duration_min: 55, rpe: 8, status: 'planned' },
    { name: 'Long run', type: 'long', description: '24km steady. 18km easy + 6km MP.', day: 'Sunday', workout_index: 0, target_pace: '5:00 min/km', est_duration_min: 130, rpe: 5, status: 'planned' },
  ],
  plan_skeleton: [
    { week: 6, phase: 'base', actual_tss: 380, completed_km: 56, marker: 'past' },
    { week: 7, phase: 'base', actual_tss: 410, completed_km: 60, marker: 'past' },
    { week: 8, phase: 'build', actual_tss: null, completed_km: null, marker: 'current' },
    { week: 9, phase: 'build', actual_tss: null, completed_km: null, marker: 'future' },
    { week: 15, phase: 'taper', actual_tss: null, completed_km: null, marker: 'future' },
    { week: 16, phase: 'race', actual_tss: null, completed_km: null, marker: 'future' },
  ],
  adaptation_log: { plan_reset_count: 0 },
  recent_activities: [],
};

// ─── HYROX mode ──────────────────────────────────────────────────────────────

export const baseHyroxContext = {
  mode: 'hyrox',
  today: '2026-05-14',
  athlete: {
    race_date: '2026-08-01',
    week: 6,
    total_weeks: 14,
    phase: 'build',
    tier: 'performance',
  },
  readiness: {
    score: 70, label: 'Good', stance: 'normal',
    primary_message: 'Solid block — stick with it.',
    tsb_daily: 0.2, acwr: 0.92, acwr_status: 'safe',
    hrv_ms: 56, hrv_pct_vs_baseline: 1,
    sleep_last_night: 74, sleep_7d_avg: 72, sleep_debt_hours: -0.5,
    today_feeling: null, blockers: [],
  },
  fitness_trend: {
    tss_8_weeks: [260, 280, 300, 320, 345, 365, 380, 395],
    week_tss: 180, planned_week_tss: 395, week_tss_pct: 46,
  },
  priorities: null,
  memory_facts: [],
  injury: null,
  illness: null,
  this_week_plan: [
    {
      name: 'Stations + run', type: 'hyrox_station', discipline: 'station',
      description: '4 stations (SkiErg + Sled Push + Burpees + Rowing) with 1km easy run between each.',
      day: 'Tuesday', workout_index: 0, est_duration_min: 70, rpe: 7, musculo_tendon_load: 380, status: 'planned',
    },
    {
      name: 'Easy run', type: 'easy_run', discipline: 'run',
      description: '8km easy aerobic. Z2 only.',
      day: 'Thursday', workout_index: 0, est_duration_min: 42, rpe: 3, musculo_tendon_load: 80, status: 'planned',
    },
    {
      name: 'Brick station', type: 'brick', discipline: 'brick',
      description: '4km run + Wall Balls + Sandbag Lunges. Race rehearsal.',
      day: 'Saturday', workout_index: 0, est_duration_min: 55, rpe: 8, musculo_tendon_load: 420, status: 'planned',
    },
  ],
  plan_skeleton: [
    { week: 4, phase: 'base', planned_tss: 320, planned_hours: 7, sessions: { swim: 0, bike: 0, run: 3 }, key_sessions: [], marker: 'past' },
    { week: 5, phase: 'base', planned_tss: 350, planned_hours: 7.5, sessions: { swim: 0, bike: 0, run: 3 }, key_sessions: [], marker: 'past' },
    { week: 6, phase: 'build', planned_tss: 395, planned_hours: 8, sessions: { swim: 0, bike: 0, run: 4 }, key_sessions: ['brick'], marker: 'current' },
    { week: 13, phase: 'taper', planned_tss: 200, planned_hours: 4.5, sessions: { swim: 0, bike: 0, run: 3 }, key_sessions: [], marker: 'future' },
    { week: 14, phase: 'race', planned_tss: 80, planned_hours: 2.5, sessions: { swim: 0, bike: 0, run: 1 }, key_sessions: [], marker: 'future' },
  ],
  adaptation_log: { plan_reset_count: 0 },
  recent_activities: [],
};
