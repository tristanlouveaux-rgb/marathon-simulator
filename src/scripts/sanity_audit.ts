
import { blendPredictions, calculateForecast, predictFromLT, predictFromPB, predictFromRecent, predictFromVO2 } from '../calculations/predictions';
import { cv, vt } from '../calculations/vdot';
import { inferLevel, getAbilityBand } from '../calculations/fatigue';
import { ft } from '../utils/format';
import type { PBs, RunnerType, RecentRun, TrainingHorizonInput } from '../types';
import type { OnboardingState, RunnerExperience, RaceDistance } from '../types/onboarding';

// --- Constants & Configuration ---

const BASELINE_VDOT = 50;
const BASELINE_5K_SEC = 1200; // 20:00

const RUNNER_TYPES = [
    { label: 'Speed', b: 1.15, typeStr: 'Speed' },
    { label: 'Balanced', b: 1.09, typeStr: 'Balanced' },
    { label: 'Endurance', b: 1.03, typeStr: 'Endurance' },
];

const SCENARIOS = [
    // 1. Sanity Control (3 types)
    ...RUNNER_TYPES.map(rt => ({ rt, variant: 'Control' })),

    // 2. Edge: No LT (3 types)
    ...RUNNER_TYPES.map(rt => ({ rt, variant: 'No LT' })),

    // 3. Edge: No Recent (3 types)
    ...RUNNER_TYPES.map(rt => ({ rt, variant: 'No Recent' })),

    // 4. Edge: PB Shift -5% (3 types)
    ...RUNNER_TYPES.map(rt => ({ rt, variant: 'PB -5%' })),
];

const TARGET_DISTANCES: RaceDistance[] = ['5k', '10k', 'half', 'marathon'];
const DIST_METERS = { '5k': 5000, '10k': 10000, 'half': 21097, 'marathon': 42195 };

// --- Helpers ---

function calculateLTPace(vdot: number): number {
    let low = 10000, high = 25000;
    for (let i = 0; i < 20; i++) {
        const mid = (low + high) / 2;
        const time = vt(mid / 1000, vdot);
        if (time > 3600) high = mid;
        else low = mid;
    }
    const dist60 = (low + high) / 2;
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
    const time = vt(10, targetVdot);
    return { d: 10, t: time, date: new Date(), weeksAgo };
}

// --- Internal Weight Logic Replication (Must Match predictions.ts) ---
function getWeights(
    targetDist: number,
    hasRecent: boolean,
    recentWeeksAgo: number
): { recent: number; pb: number; lt: number; vo2: number } {

    let baseWeights: Record<number, { recent: number; pb: number; lt: number; vo2: number }>;

    if (hasRecent) {
        baseWeights = {
            5000: { recent: 0.30, pb: 0.10, lt: 0.35, vo2: 0.25 },
            10000: { recent: 0.30, pb: 0.10, lt: 0.40, vo2: 0.20 }, // Fixed typo in previous key check, code uses [targetDist]
            21097: { recent: 0.30, pb: 0.10, lt: 0.45, vo2: 0.15 },
            42195: { recent: 0.25, pb: 0.05, lt: 0.55, vo2: 0.15 }
        };
    } else {
        baseWeights = {
            5000: { recent: 0, pb: 0.20, lt: 0.40, vo2: 0.40 },
            10000: { recent: 0, pb: 0.20, lt: 0.45, vo2: 0.35 },
            21097: { recent: 0, pb: 0.15, lt: 0.60, vo2: 0.25 },
            42195: { recent: 0, pb: 0.10, lt: 0.70, vo2: 0.20 }
        };
    }

    // Use 42195 as fallback if exact distance not found (though here we use exact keys)
    const defaults = baseWeights[42195];
    const w = { ...(baseWeights[targetDist] || defaults) };

    // Recency Decay Logic
    if (hasRecent && w.recent > 0) {
        let recencyFactor = 1.0;
        if (recentWeeksAgo <= 2) recencyFactor = 1.0;
        else if (recentWeeksAgo <= 4) recencyFactor = 0.85;
        else if (recentWeeksAgo <= 6) recencyFactor = 0.65;
        else if (recentWeeksAgo <= 8) recencyFactor = 0.40;
        else recencyFactor = 0.15;

        if (recencyFactor < 1.0) {
            const recentReduction = w.recent * (1 - recencyFactor);
            w.recent = w.recent * recencyFactor;
            w.lt = w.lt + recentReduction * 0.7; // Redistribution
            w.pb = w.pb + recentReduction * 0.3;
        }
    }

    return w;
}

// --- Main Execution ---

const headers = [
    'runnerType', 'variant',
    'pb_5k', 'pb_10k', 'pb_half', 'pb_marathon',
    'pb_5k_sec', 'pb_10k_sec', 'pb_half_sec', 'pb_marathon_sec',
    'pred_5k_sec', 'pred_10k_sec', 'pred_half_sec', 'pred_marathon_sec',
    'diff_5k_sec', 'diff_mar_sec',
    'vdot_pb', 'vdot_lt', 'vdot_recent', 'vdot_blended',
    'w_pb', 'w_lt', 'w_recent', 'w_vo2',
    'forecast_vdot_4w', 'forecast_delta_4w',
    'forecast_vdot_8w', 'forecast_delta_8w',
    'forecast_vdot_16w', 'forecast_delta_16w',
    'guardrail_flags'
];

console.log(headers.join(','));

SCENARIOS.forEach((scen, idx) => {
    try {
        // 1. Setup Parameters
        const { rt, variant } = scen;

        // Default Params
        let pbFactor = 1.0;
        let ltOffset: number | null = 0; // Aligned
        let recentOffset: number | null = 0; // Aligned
        let recentWeeks = 6;
        const segment = 'intermediate';

        // Apply Variants
        if (variant === 'No LT') ltOffset = null;
        if (variant === 'No Recent') recentOffset = null;
        if (variant === 'PB -5%') pbFactor = 0.95;

        // 2. Generate Inputs
        const base5k = BASELINE_5K_SEC * pbFactor;
        const pbs = createCoherentPBs(base5k, rt.b);
        const pbVdot = cv(5000, base5k);

        const ltPace = ltOffset !== null ? calculateLTPace(pbVdot + ltOffset) : null;
        const recent = getRecentRun(pbVdot, recentOffset, recentWeeks);

        // 3. Run Predictions & Extract Weights (Focus on MARATHON for detailed breakdown)
        // We run all distances for the time columns, but detailed breakdown is for Marathon
        const predTimes: Record<string, number> = {};
        let blendedVdotForDetails = 0;
        let weightsForDetails: any = {};
        let subVdotsForDetails: any = {};

        TARGET_DISTANCES.forEach(distKey => {
            const distMeters = DIST_METERS[distKey];

            // Call Real Engine
            const predSec = blendPredictions(
                distMeters, pbs, ltPace, null, rt.b, rt.typeStr, recent
            );

            if (!predSec) throw new Error(`Prediction failed for ${distKey}`);
            predTimes[distKey] = predSec;

            // If Marathon, extract details
            if (distKey === 'marathon') {
                const tPB = predictFromPB(distMeters, pbs, rt.b);
                const tLT = predictFromLT(distMeters, ltPace, rt.typeStr);
                const tRecent = predictFromRecent(distMeters, recent, pbs, rt.b);

                // Convert times to VDOTs for reporting (inverse of blending logic but illustrative)
                // Wait, blending is done in TIME domain.
                // User asked for "vdot_pb, vdot_lt...". 
                // Technically these components are TIMES.
                // We will output the TIME-equivalent VDOTs for comparison.

                const vPB = tPB ? cv(distMeters, tPB) : 0;
                const vLT = tLT ? cv(distMeters, tLT) : 0;
                const vRecent = tRecent ? cv(distMeters, tRecent) : 0;
                const vBlended = cv(distMeters, predSec);

                subVdotsForDetails = { pb: vPB, lt: vLT, recent: vRecent, blended: vBlended };

                // Replicate Weights
                weightsForDetails = getWeights(distMeters, !!(recent && recent.t > 0), recent?.weeksAgo || 0);

                // Assertion 2: Verify Blending Re-calculation
                let sum = 0;
                let totW = 0;
                if (tRecent && recentOffset !== null) { sum += tRecent * weightsForDetails.recent; totW += weightsForDetails.recent; }
                if (tPB) { sum += tPB * weightsForDetails.pb; totW += weightsForDetails.pb; }
                if (tLT) { sum += tLT * weightsForDetails.lt; totW += weightsForDetails.lt; }
                // VO2 is null here

                const recalcTime = sum / totW;
                if (Math.abs(recalcTime - predSec) > 1.0) {
                    throw new Error(`Assertion Failed: Blending Mismatch. Engine: ${predSec}, Recalc: ${recalcTime}`);
                }
            }
        });

        // 4. Forecasts
        const startVdot = cv(DIST_METERS['marathon'], predTimes['marathon']); // Anchor on Marathon prediction
        const forecasts: Record<number, { v: number, d: number }> = {};
        const guards: string[] = [];

        [4, 8, 16].forEach(w => {
            const stateMock = {
                planDurationWeeks: w,
                raceDistance: 'marathon',
                experienceLevel: segment,
                pbs: pbs
            } as any;

            const res = calculateForecast(startVdot, 4, stateMock, rt.typeStr as RunnerType);
            forecasts[w] = { v: res.forecastVdot, d: res.forecastVdot - startVdot };

            // Detect guardrails (simple inference: if 16w gain is very low for appropriate inputs)
            // Or check simple monotonicity
        });

        // Assertion 3: Monotonicity
        if (forecasts[16].v < forecasts[8].v || forecasts[8].v < forecasts[4].v) {
            guards.push("non_monotonic");
        }
        // Check for zero gain
        if (forecasts[16].d === 0) guards.push("clamped_zero");

        // Assertion 1: Diffs
        const d5 = predTimes['5k'] - pbs.k5;
        const dM = predTimes['marathon'] - pbs.m;

        // Output Row
        const row = [
            rt.label, variant,
            ft(pbs.k5), ft(pbs.k10), ft(pbs.h), ft(pbs.m),
            pbs.k5.toFixed(1), pbs.k10.toFixed(1), pbs.h.toFixed(1), pbs.m.toFixed(1),
            predTimes['5k'].toFixed(1), predTimes['10k'].toFixed(1), predTimes['half'].toFixed(1), predTimes['marathon'].toFixed(1),
            d5.toFixed(1), dM.toFixed(1),
            subVdotsForDetails.pb.toFixed(1), subVdotsForDetails.lt.toFixed(1), subVdotsForDetails.recent.toFixed(1), subVdotsForDetails.blended.toFixed(1),
            weightsForDetails.pb.toFixed(2), weightsForDetails.lt.toFixed(2), weightsForDetails.recent.toFixed(2), weightsForDetails.vo2.toFixed(2),
            forecasts[4].v.toFixed(2), forecasts[4].d.toFixed(2),
            forecasts[8].v.toFixed(2), forecasts[8].d.toFixed(2),
            forecasts[16].v.toFixed(2), forecasts[16].d.toFixed(2),
            guards.length > 0 ? guards.join('|') : 'ok'
        ];

        console.log(row.join(','));

    } catch (e: any) {
        console.error(`FATAL ERROR row ${idx}: ${e.message}`);
        process.exit(1);
    }
});
