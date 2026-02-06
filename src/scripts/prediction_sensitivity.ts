
import { blendPredictions } from '../calculations/predictions';
import { ft } from '../utils/format';
import type { PBs, RunnerType } from '../types';

// Constants
const LT_PACE_SEC_KM = 240; // 4:00/km
const BASELINE_5K_SEC = 1200; // 20:00

// Runner Type Definitions (Corrected Semantics as requested)
// Speed: High b (fast fade), String "Speed"
// Endurance: Low b (slow fade), String "Endurance"
const RUNNER_TYPES = [
    { label: 'Speed', b: 1.15, type: 'Speed' },
    { label: 'Balanced', b: 1.09, type: 'Balanced' },
    { label: 'Endurance', b: 1.03, type: 'Endurance' },
];

// PB Sweep Levels
const SWEEP = [
    { label: 'Baseline', factor: 1.0 },
    { label: '-1%', factor: 0.99 },
    { label: '-2%', factor: 0.98 },
    { label: '-3%', factor: 0.97 },
    { label: '-5%', factor: 0.95 },
];

const TARGET_DISTANCES = [5000, 10000, 21097, 42195];

function formatTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Mock utils/format if needed, but I'll use local helper
const fmt = formatTime;

const results: Record<string, any[]> = {};

console.log('Running Prediction Sensitivity Audit...');
console.log(`Fixed LT Pace: ${formatTime(LT_PACE_SEC_KM)}/km`);
console.log(`Baseline 5K: ${formatTime(BASELINE_5K_SEC)}`);
console.log('------------------------------------------------');

RUNNER_TYPES.forEach(rt => {
    console.log(`\nAnalyzing Runner Type: ${rt.label} (b=${rt.b})`);
    const typeResults = [];

    let baselinePreds: Record<number, number> = {};

    SWEEP.forEach((level, idx) => {
        const k5Time = BASELINE_5K_SEC * level.factor;
        const pbs: PBs = { k5: k5Time }; // Only 5K PB provided

        const row: any = {
            label: level.label,
            k5Input: k5Time,
            preds: {}
        };

        TARGET_DISTANCES.forEach(dist => {
            // Predict
            // Note: passing null for VO2 and RecentRun to isolate PB/LT blending
            const pred = blendPredictions(
                dist,
                pbs,
                LT_PACE_SEC_KM,
                null, // vo2
                rt.b,
                rt.type,
                null // recentRun
            );

            if (pred) {
                row.preds[dist] = pred;
                if (idx === 0) baselinePreds[dist] = pred;
            }
        });

        typeResults.push(row);
    });

    results[rt.label] = { rows: typeResults, baseline: baselinePreds };
});


// Output Tables
RUNNER_TYPES.forEach(rt => {
    console.log(`\n### Table: ${rt.label} Runner (b=${rt.b})`);
    console.log('| 5K PB | Pred 5K | Pred 10K | Pred HM | Pred Marathon |');
    console.log('|---|---|---|---|---|');

    const data = results[rt.label];

    data.rows.forEach((row: any) => {
        const k5Ref = row.k5Input;
        const p5 = row.preds[5000];
        const p10 = row.preds[10000];
        const pHM = row.preds[21097];
        const pM = row.preds[42195];

        // Format times and diffs
        // Baseline row doesn't show diffs usually, or maybe just 0
        // User requested: "Also include: - absolute time change vs baseline - % change vs baseline for each distance"
        // I will put them in separate text or formatted in the cell?
        // "pred 5K" cell.
        // The user output request: "Pred 5K | Pred 10K..." as columns.
        // "Also include...". Maybe below or combined?
        // "Produce ONE table per runner type... After the tables: Briefly comment"
        // I misread "Rows: Baseline, -1%...".

        // Let's print the pure time table first, then a change table? Or composite?
        // "Pred 5K" column usually just has time.
        // I will print the Time.
        // Then I will print a second table "Changes vs Baseline" for clarity?
        // Or format as "20:00 (-0:12, -1.0%)"? That might be too wide.
        // Let's stick to Time first as requested in the Layout.
        // "Also include...".

        console.log(`| ${fmt(k5Ref)} | ${fmt(p5)} | ${fmt(p10)} | ${fmt(pHM)} | ${fmt(pM)} |`);
    });

    // Calculate changes for the last row (-5%) vs Baseline to show sensitivity?
    // Or print a separate small summary block.
    console.log(`\n**Changes vs Baseline (at -5% PB improvement):**`);
    const base = data.rows[0];
    const last = data.rows[data.rows.length - 1]; // -5%

    TARGET_DISTANCES.forEach(dist => {
        const bT = base.preds[dist];
        const lT = last.preds[dist];
        const diff = lT - bT;
        const pct = (diff / bT) * 100;
        const distLabel = dist === 5000 ? '5K' : dist === 10000 ? '10K' : dist === 21097 ? 'HM' : 'Marathon';
        console.log(`- **${distLabel}**: ${fmt(diff)} (${pct.toFixed(2)}%)`);
    });
});
