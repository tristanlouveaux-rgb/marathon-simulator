#!/usr/bin/env npx tsx
/**
 * CLI Runner for Forecast Matrix
 *
 * Usage:
 *   npx tsx src/testing/run-forecast-matrix.ts
 *   npx tsx src/testing/run-forecast-matrix.ts --json
 *   npx tsx src/testing/run-forecast-matrix.ts --distance 10k --vdot 50
 */

import { runForecastMatrix, formatMatrixAsTable } from './forecast-matrix';
import type { RaceDistance } from '@/types';

// Parse CLI args
const args = process.argv.slice(2);
const jsonOnly = args.includes('--json');

let targetDistance: RaceDistance = '5k';
let baseVdot = 45;
let sessionsPerWeek = 4;
let experienceLevel = 'intermediate';

// Parse options
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--distance' && args[i + 1]) {
    targetDistance = args[i + 1] as RaceDistance;
  }
  if (args[i] === '--vdot' && args[i + 1]) {
    baseVdot = parseFloat(args[i + 1]);
  }
  if (args[i] === '--sessions' && args[i + 1]) {
    sessionsPerWeek = parseInt(args[i + 1]);
  }
  if (args[i] === '--experience' && args[i + 1]) {
    experienceLevel = args[i + 1];
  }
}

// Run the matrix
console.log('Running Forecast Matrix Audit...\n');
console.log(`Configuration:`);
console.log(`  Target Distance: ${targetDistance}`);
console.log(`  Base VDOT: ${baseVdot}`);
console.log(`  Sessions/Week: ${sessionsPerWeek}`);
console.log(`  Experience: ${experienceLevel}`);
console.log('');

const output = runForecastMatrix(targetDistance, baseVdot, sessionsPerWeek, experienceLevel);

if (jsonOnly) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(formatMatrixAsTable(output));
  console.log('\n--- JSON Output (truncated) ---\n');
  console.log(JSON.stringify({
    timestamp: output.timestamp,
    targetDistance: output.targetDistance,
    baseVdot: output.baseVdot,
    runnerTypeSemanticsAudit: output.runnerTypeSemanticsAudit,
    scenarioCount: output.scenarios.length,
    sampleScenario: output.scenarios[0],
  }, null, 2));
}
