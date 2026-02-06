/**
 * Forecast Matrix Runner
 * ======================
 *
 * Runs a scenario matrix through the REAL prediction engine to audit behavior.
 * Uses synthetic athletes with known properties to verify engine outputs.
 *
 * AUDIT PRINCIPLE: Every output must trace back to a specific code path.
 *
 * SCENARIO AXES:
 * 1. Runner Type (via bTarget): 1.03 (low fade), 1.09 (balanced), 1.15 (high fade)
 * 2. LT Profile: ltVdotDiff in {-2, 0, +2}
 * 3. Recent Run: none / fresh(2wk) / stale(6wk)
 * 4. Recent Performance: recentVdotDiff in {-2, 0, +2}
 *
 * FORECASTS: 8, 12, 16 weeks
 *
 * SOURCE FILES:
 * - blendPredictions(): src/calculations/predictions.ts
 * - cv(): src/calculations/vdot.ts
 * - applyTrainingHorizonAdjustment(): src/calculations/training-horizon.ts
 */

import type { RaceDistance, RunnerType, AbilityBand } from '@/types';
import {
  createSyntheticAthlete,
  coherenceReport,
  formatTime,
  type SyntheticAthlete,
  type SyntheticAthleteConfig,
} from './synthetic-athlete';
import { blendPredictions } from '@/calculations/predictions';
import { applyTrainingHorizonAdjustment } from '@/calculations/training-horizon';
import { cv, tv, rd } from '@/calculations/vdot';
import { getAbilityBand, calculateFatigueExponent, getRunnerType } from '@/calculations/fatigue';

/** Forecast result for a single week configuration */
export interface ForecastOutput {
  weeksRemaining: number;
  vdotGain: number;
  improvementPct: number;
  forecastVdot: number;
  forecastTimeSec: number;
  forecastTimeFormatted: string;
  components: {
    weekFactor: number;
    sessionFactor: number;
    typeModifier: number;
    undertrainPenalty: number;
    taperBonus: number;
  };
}

/** Complete scenario result */
export interface ScenarioResult {
  scenarioId: string;
  config: SyntheticAthleteConfig;
  athlete: SyntheticAthlete;
  coherenceReport: ReturnType<typeof coherenceReport>;

  // Blend prediction results
  targetDistanceMeters: number;
  targetDistanceKey: RaceDistance;
  blendedPredictionSec: number | null;
  blendedPredictionFormatted: string;
  startVdot: number | null;

  // Individual predictor contributions
  predictorDebug: {
    tPB: number | null;
    tLT: number | null;
    tVO2: number | null;
    tRecent: number | null;
  };

  // Forecast results
  forecasts: {
    week8: ForecastOutput;
    week12: ForecastOutput;
    week16: ForecastOutput;
  };
}

/** Matrix run summary */
export interface MatrixOutput {
  timestamp: string;
  targetDistance: RaceDistance;
  baseVdot: number;
  sessionsPerWeek: number;
  experienceLevel: string;
  scenarios: ScenarioResult[];
  runnerTypeSemanticsAudit: {
    issue: string;
    currentBehavior: string;
    expectedBehavior: string;
    recommendation: string;
  };
}

/**
 * Run forecast for given parameters through the REAL engine.
 */
function runForecast(
  startVdot: number,
  targetDistance: RaceDistance,
  weeksRemaining: number,
  sessionsPerWeek: number,
  runnerType: RunnerType,
  experienceLevel: string
): ForecastOutput {
  const abilityBand = getAbilityBand(startVdot);

  // Taper weeks: 1 for 5k, 2 for 10k/half, 3 for marathon
  const taperWeeks = targetDistance === '5k' ? 1 :
                     targetDistance === 'marathon' ? 3 : 2;

  // Call the REAL engine function
  const result = applyTrainingHorizonAdjustment({
    baseline_vdot: startVdot,
    target_distance: targetDistance,
    weeks_remaining: weeksRemaining,
    sessions_per_week: sessionsPerWeek,
    runner_type: runnerType,
    ability_band: abilityBand,
    taper_weeks: taperWeeks,
    experience_level: experienceLevel,
  });

  const forecastVdot = startVdot + result.vdot_gain;
  const forecastTimeSec = tv(forecastVdot, targetDistance === '5k' ? 5 :
                                           targetDistance === '10k' ? 10 :
                                           targetDistance === 'half' ? 21.097 :
                                           42.195);

  return {
    weeksRemaining,
    vdotGain: result.vdot_gain,
    improvementPct: result.improvement_pct,
    forecastVdot,
    forecastTimeSec,
    forecastTimeFormatted: formatTime(forecastTimeSec),
    components: {
      weekFactor: result.components.week_factor,
      sessionFactor: result.components.session_factor,
      typeModifier: result.components.type_modifier,
      undertrainPenalty: result.components.undertrain_penalty,
      taperBonus: result.components.taper_bonus,
    },
  };
}

/**
 * Run a single scenario through the prediction pipeline.
 */
export function runScenario(
  scenarioId: string,
  config: SyntheticAthleteConfig,
  targetDistance: RaceDistance,
  sessionsPerWeek: number,
  experienceLevel: string
): ScenarioResult {
  // Generate synthetic athlete
  const athlete = createSyntheticAthlete(config);
  const report = coherenceReport(athlete);

  const targetDistanceMeters = rd(targetDistance);

  // Run blendPredictions with the REAL engine
  const blendedPredictionSec = blendPredictions(
    targetDistanceMeters,
    athlete.pbs,
    athlete.ltPaceSecPerKm,
    athlete.vo2max,
    athlete.bEstimated,
    athlete.runnerType.toLowerCase(),
    athlete.recentRun
  );

  // Calculate start VDOT from blended prediction
  const startVdot = blendedPredictionSec ? cv(targetDistanceMeters, blendedPredictionSec) : null;

  // Run forecasts for 8, 12, 16 weeks
  let forecasts: ScenarioResult['forecasts'] | null = null;
  if (startVdot) {
    forecasts = {
      week8: runForecast(startVdot, targetDistance, 8, sessionsPerWeek, athlete.runnerType, experienceLevel),
      week12: runForecast(startVdot, targetDistance, 12, sessionsPerWeek, athlete.runnerType, experienceLevel),
      week16: runForecast(startVdot, targetDistance, 16, sessionsPerWeek, athlete.runnerType, experienceLevel),
    };
  }

  return {
    scenarioId,
    config,
    athlete,
    coherenceReport: report,
    targetDistanceMeters,
    targetDistanceKey: targetDistance,
    blendedPredictionSec,
    blendedPredictionFormatted: blendedPredictionSec ? formatTime(blendedPredictionSec) : 'N/A',
    startVdot,
    predictorDebug: {
      tPB: null,  // Would need to expose individual predictors for full debug
      tLT: null,
      tVO2: null,
      tRecent: null,
    },
    forecasts: forecasts!,
  };
}

/**
 * Define the scenario matrix.
 *
 * AXES:
 * - bTarget: Controls runner type derivation (1.03=low fade, 1.09=balanced, 1.15=high fade)
 * - ltVdotDiff: LT pace relative to base VDOT
 * - recentRun: None, fresh (2wk), or stale (6wk) with performance diff
 */
export function generateScenarioConfigs(baseVdot: number): { id: string; config: SyntheticAthleteConfig }[] {
  const scenarios: { id: string; config: SyntheticAthleteConfig }[] = [];

  // Runner type bands (via bTarget)
  const bTargets = [
    { b: 1.03, label: 'low_fade' },    // Less fade → currently labeled "Speed" by engine (INVERTED)
    { b: 1.09, label: 'balanced' },    // Middle → "Balanced"
    { b: 1.15, label: 'high_fade' },   // More fade → currently labeled "Endurance" by engine (INVERTED)
  ];

  // LT profile offsets
  const ltDiffs = [-2, 0, 2];

  // Recent run configurations
  const recentConfigs: (SyntheticAthleteConfig['recentRun'] | null)[] = [
    null,  // No recent run
    { distanceKm: 10, vdotDiff: 0, weeksAgo: 2 },   // Fresh, on-target
    { distanceKm: 10, vdotDiff: 2, weeksAgo: 2 },   // Fresh, overperforming
    { distanceKm: 10, vdotDiff: -2, weeksAgo: 2 },  // Fresh, underperforming
    { distanceKm: 10, vdotDiff: 0, weeksAgo: 6 },   // Stale, on-target
  ];

  for (const { b: bTarget, label: bLabel } of bTargets) {
    for (const ltDiff of ltDiffs) {
      for (let ri = 0; ri < recentConfigs.length; ri++) {
        const recentConfig = recentConfigs[ri];
        const recentLabel = recentConfig === null ? 'no_recent' :
                           `recent_${recentConfig.weeksAgo}wk_diff${recentConfig.vdotDiff >= 0 ? '+' : ''}${recentConfig.vdotDiff}`;

        const id = `${bLabel}_lt${ltDiff >= 0 ? '+' : ''}${ltDiff}_${recentLabel}`;

        scenarios.push({
          id,
          config: {
            baseVdot,
            bTarget,
            ltVdotDiff: ltDiff,
            vo2VdotDiff: 0,  // Keep VO2 aligned with base for simplicity
            recentRun: recentConfig,
          },
        });
      }
    }
  }

  return scenarios;
}

/**
 * Run the full forecast matrix.
 */
export function runForecastMatrix(
  targetDistance: RaceDistance = '5k',
  baseVdot: number = 45,
  sessionsPerWeek: number = 4,
  experienceLevel: string = 'intermediate'
): MatrixOutput {
  const scenarios = generateScenarioConfigs(baseVdot);
  const results: ScenarioResult[] = [];

  for (const { id, config } of scenarios) {
    const result = runScenario(id, config, targetDistance, sessionsPerWeek, experienceLevel);
    results.push(result);
  }

  return {
    timestamp: new Date().toISOString(),
    targetDistance,
    baseVdot,
    sessionsPerWeek,
    experienceLevel,
    scenarios: results,
    runnerTypeSemanticsAudit: {
      issue: 'Runner type labels are INVERTED relative to user requirement',
      currentBehavior: 'b < 1.06 → "Speed", b > 1.12 → "Endurance"',
      expectedBehavior: 'b > 1.12 → "Speed" (high fade = worse endurance), b < 1.06 → "Endurance" (low fade = better endurance)',
      recommendation: 'Swap labels in getRunnerType() or add semantic mapping layer',
    },
  };
}

/**
 * Format matrix output as CSV-like text table.
 */
export function formatMatrixAsTable(output: MatrixOutput): string {
  const lines: string[] = [];

  lines.push('='.repeat(120));
  lines.push('FORECAST MATRIX AUDIT REPORT');
  lines.push('='.repeat(120));
  lines.push(`Timestamp: ${output.timestamp}`);
  lines.push(`Target Distance: ${output.targetDistance}`);
  lines.push(`Base VDOT: ${output.baseVdot}`);
  lines.push(`Sessions/Week: ${output.sessionsPerWeek}`);
  lines.push(`Experience Level: ${output.experienceLevel}`);
  lines.push('');

  lines.push('RUNNER TYPE SEMANTICS AUDIT:');
  lines.push(`  Issue: ${output.runnerTypeSemanticsAudit.issue}`);
  lines.push(`  Current: ${output.runnerTypeSemanticsAudit.currentBehavior}`);
  lines.push(`  Expected: ${output.runnerTypeSemanticsAudit.expectedBehavior}`);
  lines.push(`  Recommendation: ${output.runnerTypeSemanticsAudit.recommendation}`);
  lines.push('');

  // Header
  const header = [
    'Scenario'.padEnd(45),
    'bTarget',
    'bEst',
    'Type'.padEnd(10),
    '5k PB'.padEnd(8),
    'LT/km'.padEnd(7),
    'Blend'.padEnd(8),
    'StartV',
    '8w Fcst',
    '12w Fcst',
    '16w Fcst',
    'Coherent',
  ].join(' | ');

  lines.push('-'.repeat(header.length));
  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const s of output.scenarios) {
    const row = [
      s.scenarioId.padEnd(45),
      s.config.bTarget.toFixed(2),
      s.athlete.bEstimated.toFixed(2),
      s.athlete.runnerType.padEnd(10),
      formatTime(s.athlete.pbs.k5!).padEnd(8),
      s.athlete.ltPaceSecPerKm ? formatTime(s.athlete.ltPaceSecPerKm).padEnd(7) : 'N/A'.padEnd(7),
      s.blendedPredictionFormatted.padEnd(8),
      s.startVdot ? s.startVdot.toFixed(1) : 'N/A',
      s.forecasts ? s.forecasts.week8.forecastTimeFormatted : 'N/A',
      s.forecasts ? s.forecasts.week12.forecastTimeFormatted : 'N/A',
      s.forecasts ? s.forecasts.week16.forecastTimeFormatted : 'N/A',
      s.coherenceReport.isCoherent ? 'YES' : 'NO',
    ].join(' | ');
    lines.push(row);
  }

  lines.push('-'.repeat(header.length));
  lines.push('');

  // Detailed breakdown for first few scenarios
  lines.push('DETAILED BREAKDOWN (first 3 scenarios):');
  lines.push('');

  for (const s of output.scenarios.slice(0, 3)) {
    lines.push(`--- ${s.scenarioId} ---`);
    lines.push(`  Config: bTarget=${s.config.bTarget}, ltDiff=${s.config.ltVdotDiff}, vo2Diff=${s.config.vo2VdotDiff}`);
    lines.push(`  PBs: 5k=${formatTime(s.athlete.pbs.k5!)}, 10k=${formatTime(s.athlete.pbs.k10!)}, HM=${formatTime(s.athlete.pbs.h!)}, M=${formatTime(s.athlete.pbs.m!)}`);
    lines.push(`  Derived: bEst=${s.athlete.bEstimated.toFixed(4)}, type=${s.athlete.runnerType}`);
    lines.push(`  LT Pace: ${s.athlete.ltPaceSecPerKm ? formatTime(s.athlete.ltPaceSecPerKm) + '/km' : 'N/A'}`);
    lines.push(`  VO2max: ${s.athlete.vo2max ?? 'N/A'}`);
    lines.push(`  Recent: ${s.athlete.recentRun ? `${s.athlete.recentRun.d}km in ${formatTime(s.athlete.recentRun.t)}, ${s.athlete.recentRun.weeksAgo}wk ago` : 'None'}`);
    lines.push(`  Blended Prediction: ${s.blendedPredictionFormatted} (${s.blendedPredictionSec?.toFixed(1)}s)`);
    lines.push(`  Start VDOT: ${s.startVdot?.toFixed(2) ?? 'N/A'}`);

    if (s.forecasts) {
      lines.push(`  Forecasts:`);
      for (const [label, fc] of [['8w', s.forecasts.week8], ['12w', s.forecasts.week12], ['16w', s.forecasts.week16]] as const) {
        lines.push(`    ${label}: +${fc.vdotGain.toFixed(2)} VDOT (${fc.improvementPct.toFixed(1)}%) → ${fc.forecastVdot.toFixed(1)} → ${fc.forecastTimeFormatted}`);
        lines.push(`        Components: wkF=${fc.components.weekFactor.toFixed(3)}, sessF=${fc.components.sessionFactor.toFixed(3)}, typeMod=${fc.components.typeModifier.toFixed(2)}, underP=${fc.components.undertrainPenalty.toFixed(3)}, taperB=${fc.components.taperBonus.toFixed(3)}`);
      }
    }

    // Coherence report
    lines.push(`  Coherence: ${s.coherenceReport.isCoherent ? 'PASS' : 'FAIL'}`);
    for (const check of s.coherenceReport.checks) {
      const status = check.passed ? '✓' : '✗';
      lines.push(`    ${status} ${check.name}: ${check.message}`);
    }
    lines.push('');
  }

  // Derivation chain documentation
  lines.push('DERIVATION CHAIN (code paths):');
  lines.push('  1. baseVdot → anchor 5k time: tv(baseVdot, 5) [vdot.ts:tv()]');
  lines.push('  2. anchor time + bTarget → PBs: T(d) = T_anchor * (d/5000)^b [Riegel power law]');
  lines.push('  3. PBs → bEstimated: calculateFatigueExponent(pbs) [fatigue.ts:calculateFatigueExponent()]');
  lines.push('  4. bEstimated → runnerType: getRunnerType(b) [fatigue.ts:getRunnerType()]');
  lines.push('  5. baseVdot + ltDiff → ltPace: 60min race pace at VDOT [computeLtPaceFromVdot60min()]');
  lines.push('  6. All inputs → blendedTime: blendPredictions(...) [predictions.ts:blendPredictions()]');
  lines.push('  7. blendedTime → startVdot: cv(targetDist, blendedTime) [vdot.ts:cv()]');
  lines.push('  8. startVdot + params → forecast: applyTrainingHorizonAdjustment(...) [training-horizon.ts]');
  lines.push('');

  return lines.join('\n');
}

/**
 * Main entry point - run and print the matrix.
 */
export function main(): void {
  console.log('Running Forecast Matrix...\n');

  const output = runForecastMatrix('5k', 45, 4, 'intermediate');

  // Print formatted table
  console.log(formatMatrixAsTable(output));

  // Print JSON for programmatic access
  console.log('\n=== JSON OUTPUT ===\n');
  console.log(JSON.stringify(output, null, 2));
}

// Export for CLI execution
export { main as runMatrix };
