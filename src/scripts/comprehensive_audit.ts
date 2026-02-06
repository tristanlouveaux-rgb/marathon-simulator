
import { blendPredictions, calculateForecast } from '../calculations/predictions';
import { cv, vt, rdKm } from '../calculations/vdot';
import { inferLevel, getAbilityBand } from '../calculations/fatigue';
import { ft } from '../utils/format';
import type { PBs, RunnerType, RecentRun, TrainingHorizonInput } from '../types';
import type { OnboardingState, RunnerExperience, RaceDistance } from '../types/onboarding';

// --- Constants & Configuration ---

const BASELINE_VDOT = 50; // Approx 20:00 5k
const BASELINE_5K_SEC = 1200; // 20:00

// 1. Runner Types (Physics from b, Corrected Semantics)
const RUNNER_TYPES = [
    { label: 'Speed', b: 1.15, typeStr: 'Speed' },
    { label: 'Balanced', b: 1.09, typeStr: 'Balanced' },
    { label: 'Endurance', b: 1.03, typeStr: 'Endurance' },
];

// 2. LT Profile (VDOT Offsets)
const LT_PROFILES = [
    { label: 'Weak', vdotOffset: -2 },
    { label: 'Aligned', vdotOffset: 0 },
    { label: 'Strong', vdotOffset: 2 },
    { label: 'None', vdotOffset: null }, // Edge case
];

// 3. Recent Performance
const RECENT_PROFILES = [
    { label: 'Under', vdotOffset: -2 },
    { label: 'Aligned', vdotOffset: 0 },
    { label: 'Over', vdotOffset: 2 },
    { label: 'None', vdotOffset: null }, // Edge case
];

const RECENT_AGES = [2, 6, 10]; // Weeks

// 4. PB Improvements
const PB_SHIFTS = [
    { label: '0%', factor: 1.0 },
    { label: '-1%', factor: 0.99 },
    { label: '-2%', factor: 0.98 },
    { label: '-3%', factor: 0.97 },
    { label: '-5%', factor: 0.95 },
];

// 5. Self-Selected Segments
const SEGMENTS: RunnerExperience[] = [
    'total_beginner', 'beginner', 'novice', 'intermediate',
    'advanced', 'competitive', 'returning', 'hybrid'
];

const TARGET_DISTANCES: RaceDistance[] = ['5k', '10k', 'half', 'marathon'];
const DIST_METERS = { '5k': 5000, '10k': 10000, 'half': 21097, 'marathon': 42195 };

// --- Generators & Helpers ---

function calculateLTPace(vdot: number): number {
    // Find pace for 60 min race
    // Approximate logic: find D that takes 60 mins at vdot
    // We use binary search on distance to find what distance takes 3600s
    let low = 10000, high = 25000;
    for (let i = 0; i < 20; i++) {
        const mid = (low + high) / 2;
        const time = vt(mid / 1000, vdot);
        if (time > 3600) high = mid;
        else low = mid;
    }
    const dist60 = (low + high) / 2;
    // Pace in sec/km
    return 3600 / (dist60 / 1000);
}

function createCoherentPBs(base5kSec: number, b: number): PBs {
    const k5 = base5kSec;
    const k10 = k5 * Math.pow(10000 / 5000, b);
    const h = k5 * Math.pow(21097 / 5000, b);
    const m = k5 * Math.pow(42195 / 5000, b);
    return { k5, k10, h, m };
}

function getRecentRun(baseVdot: number, offset: number | null, weeksAgo: number): RecentRun | null {
    if (offset === null) return null;
    const targetVdot = baseVdot + offset;
    // Recent run is 10k unless specified otherwise (standardizing on 10k for this audit)
    const time = vt(10, targetVdot);
    return { d: 10, t: time, date: new Date(), weeksAgo }; // date is dummy
}

// --- Main Simulation ---

interface RowResult {
    runnerType: string;
    b: number;
    segment_selected: string;
    ability_inferred: string;

    PB_5k_label: string;
    LT_profile: string;
    recent_profile: string;
    recent_age_weeks: number | string;

    pred_5k: string;
    pred_10k: string;
    pred_half: string;
    pred_marathon: string;

    start_vdot: number;

    forecast_4w: number;
    forecast_8w: number;
    forecast_16w: number;

    delta_5k_vs_PB: number;     // seconds
    delta_marathon_vs_PB: number; // seconds

    notes: string;
}

const rows: RowResult[] = [];

console.log('Starting Comprehensive Audit...');

// Iterators
// To avoid millions of rows, we'll run specific "cuts" or specific comparative blocks.
// User asked for "OUTPUT TABLE (ONE ROW PER SCENARIO)".
// But fully multiplying all axes = 3 types * 4 LT * 4 Recent * 3 Ages * 5 Shifts * 8 Segments = ~5000 rows.
// We should structure reasonable sweeps.

// Strategy: Default fixed parameters for most, then sweep one axis at a time?
// Or generate the full matrix? The User said "Build a full ... matrix".
// Let's iterate intelligently.

// We will fix "Intermediate" segment for the physics sweeps.
// Then we will fix physics and sweep the Segments.

const DEFAULT_SEGMENT = 'intermediate';
const DEFAULT_PB_SHIFT = '0%';
const DEFAULT_RECENT = 'Aligned';
const DEFAULT_RECENT_AGE = 6;
const DEFAULT_LT = 'Aligned';

// 1. Physics Sweep (Type x LT x Recent x PB Shift)
// Keeping Segment = Intermediate
RUNNER_TYPES.forEach(rt => {
    PB_SHIFTS.forEach(pbShift => {
        // Re-calculate Baseline PBs for this shift
        const currentBase5k = BASELINE_5K_SEC * pbShift.factor;
        const pbs = createCoherentPBs(currentBase5k, rt.b);

        // We need coherent VDOT for this new PB to base offsets on
        const currentVdot = cv(5000, currentBase5k);

        LT_PROFILES.forEach(ltProf => {
            RECENT_PROFILES.forEach(recProf => {
                // If Recent is None, age doesn't matter (run once). If not None, run for all ages.
                const agesToRun = recProf.label === 'None' ? [0] : RECENT_AGES;

                agesToRun.forEach(age => {
                    // Build Inputs
                    const ltPace = ltProf.vdotOffset !== null
                        ? calculateLTPace(currentVdot + ltProf.vdotOffset)
                        : null;

                    const recent = getRecentRun(currentVdot, recProf.vdotOffset, age);

                    // Run Prediction for each distance
                    const preds: Record<string, number> = {};
                    let badData = false;

                    TARGET_DISTANCES.forEach(d => {
                        const t = blendPredictions(
                            DIST_METERS[d], pbs, ltPace, null, rt.b, rt.typeStr, recent
                        );
                        if (!t) badData = true;
                        else preds[d] = t;
                    });

                    if (badData) return; // skip

                    // Start VDOT for Forecast (using 5k prediction as anchor or 'half'?)
                    // Usually we assume 'raceDistance' anchor. Let's assume 'half' for general fitness.
                    const startVdot = cv(21097, preds['half']);

                    // Forecasts (4, 8, 16w)
                    // Using DEFAULT_SEGMENT for this sweep
                    const forecasts: Record<number, number> = {};
                    [4, 8, 16].forEach(w => {
                        // Mock state for forecast
                        const stateMock = {
                            planDurationWeeks: w,
                            raceDistance: 'marathon', // standardized on Marathon for long view? Or Half?
                            experienceLevel: DEFAULT_SEGMENT,
                            pbs: pbs
                        } as any;

                        // We utilize calculateForecast wrapper or direct applyTrainingHorizon?
                        // Use calculateForecast to mirror production
                        const res = calculateForecast(startVdot, 4, stateMock, rt.typeStr as RunnerType);
                        // Wait, that func calculates *Final* vdot. We want gain.
                        // Forecast result has forecastVdot.
                        forecasts[w] = res.forecastVdot - startVdot; // Gain
                    });

                    // Metrics
                    const delta5k = preds['5k'] - pbs.k5;
                    const deltaM = preds['marathon'] - pbs.m;

                    rows.push({
                        runnerType: rt.label,
                        b: rt.b,
                        segment_selected: DEFAULT_SEGMENT,
                        ability_inferred: inferLevel(startVdot),
                        PB_5k_label: pbShift.label,
                        LT_profile: ltProf.label,
                        recent_profile: recProf.label,
                        recent_age_weeks: recProf.label === 'None' ? 'N/A' : age,
                        pred_5k: ft(preds['5k']),
                        pred_10k: ft(preds['10k']),
                        pred_half: ft(preds['half']),
                        pred_marathon: ft(preds['marathon']),
                        start_vdot: parseFloat(startVdot.toFixed(2)),
                        forecast_4w: parseFloat(forecasts[4].toFixed(2)),
                        forecast_8w: parseFloat(forecasts[8].toFixed(2)),
                        forecast_16w: parseFloat(forecasts[16].toFixed(2)),
                        delta_5k_vs_PB: parseFloat(delta5k.toFixed(1)),
                        delta_marathon_vs_PB: parseFloat(deltaM.toFixed(1)),
                        notes: ''
                    });
                });
            });
        });
    });
});

// 2. Segment Distortion Sweep
// Fix Physics to defaults, Sweep Segments
const BASE_RT = RUNNER_TYPES[1]; // Balanced
const BASE_PB = PB_SHIFTS[0]; // 0%
const BASE_LT = LT_PROFILES[1]; // Aligned
const BASE_REC = RECENT_PROFILES[1]; // Aligned
const BASE_AGE = 6;

SEGMENTS.forEach(seg => {
    const currentBase5k = BASELINE_5K_SEC; // Fixed
    const pbs = createCoherentPBs(currentBase5k, BASE_RT.b);
    const currentVdot = cv(5000, currentBase5k);
    const ltPace = calculateLTPace(currentVdot); // Aligned
    const recent = getRecentRun(currentVdot, 0, BASE_AGE); // Aligned

    // Prediction (constant for all segments as segment doesn't affect current fitness prediction)
    // But we need 'startVdot'
    const preds: Record<string, number> = {};
    TARGET_DISTANCES.forEach(d => {
        preds[d] = blendPredictions(
            DIST_METERS[d], pbs, ltPace, null, BASE_RT.b, BASE_RT.typeStr, recent
        )!;
    });
    const startVdot = cv(21097, preds['half']);

    // Calculate Forecast
    const forecasts: Record<number, number> = {};
    [4, 8, 16].forEach(w => {
        const stateMock = {
            planDurationWeeks: w,
            raceDistance: 'marathon',
            experienceLevel: seg, // <-- Varying this
            pbs: pbs
        } as any;

        const res = calculateForecast(startVdot, 4, stateMock, BASE_RT.typeStr as RunnerType);
        forecasts[w] = res.forecastVdot - startVdot;
    });

    rows.push({
        runnerType: BASE_RT.label,
        b: BASE_RT.b,
        segment_selected: seg,
        ability_inferred: inferLevel(startVdot),
        PB_5k_label: '0% (Fixed)',
        LT_profile: 'Aligned (Fixed)',
        recent_profile: 'Aligned (Fixed)',
        recent_age_weeks: BASE_AGE,
        pred_5k: ft(preds['5k']),
        pred_10k: ft(preds['10k']),
        pred_half: ft(preds['half']),
        pred_marathon: ft(preds['marathon']),
        start_vdot: parseFloat(startVdot.toFixed(2)),
        forecast_4w: parseFloat(forecasts[4].toFixed(2)),
        forecast_8w: parseFloat(forecasts[8].toFixed(2)),
        forecast_16w: parseFloat(forecasts[16].toFixed(2)),
        delta_5k_vs_PB: parseFloat((preds['5k'] - pbs.k5).toFixed(1)),
        delta_marathon_vs_PB: parseFloat((preds['marathon'] - pbs.m).toFixed(1)),
        notes: 'Segment Sweep'
    });
});


// Output CSV Style for User to Copy
const headers = [
    'runnerType', 'b', 'segment', 'inferred_ability',
    'PB_5k_shift', 'LT_profile', 'recent_perf', 'recent_age',
    'pred_5k', 'pred_10k', 'pred_half', 'pred_marathon',
    'start_vdot', 'fc_4w', 'fc_8w', 'fc_16w',
    'diff_5k_PB', 'diff_mar_PB', 'notes'
];

console.log(headers.join(','));

rows.forEach(r => {
    console.log([
        r.runnerType, r.b, r.segment_selected, r.ability_inferred,
        r.PB_5k_label, r.LT_profile, r.recent_profile, r.recent_age_weeks,
        r.pred_5k, r.pred_10k, r.pred_half, r.pred_marathon,
        r.start_vdot, r.forecast_4w, r.forecast_8w, r.forecast_16w,
        r.delta_5k_vs_PB, r.delta_marathon_vs_PB, r.notes
    ].join(','));
});
