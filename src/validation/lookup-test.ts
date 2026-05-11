/**
 * Lookup smoke test — exercise the empirical-course-factor lookup against
 * canonical race names from `src/data/triathlons.ts` and report coverage.
 *
 * Run with: `npx tsx src/validation/lookup-test.ts`
 */

import { lookupEmpiricalCourseFactors, totalCalibrationSampleSize } from '@/calculations/empirical-course-factors';

const baseSec = { swimSec: 2400, bikeSec: 11000, runSec: 7200 };

const probes: { name: string; distance: '70.3' | 'ironman' }[] = [
  // Canonical IM races
  { name: 'IRONMAN Lanzarote',          distance: 'ironman' },
  { name: 'IRONMAN Texas',              distance: 'ironman' },
  { name: 'IRONMAN Hamburg',            distance: 'ironman' },
  { name: 'IRONMAN Lake Placid',        distance: 'ironman' },
  { name: 'IRONMAN Frankfurt',          distance: 'ironman' },
  { name: 'IRONMAN World Championship', distance: 'ironman' },
  { name: 'IRONMAN Wales',              distance: 'ironman' },
  { name: 'IRONMAN Nonexistent',        distance: 'ironman' },

  // Canonical 70.3 races
  { name: 'IRONMAN 70.3 Lanzarote',     distance: '70.3' },
  { name: 'IRONMAN 70.3 Dublin',        distance: '70.3' },
  { name: 'IRONMAN 70.3 Mallorca',      distance: '70.3' },
  { name: 'IRONMAN 70.3 World Championship', distance: '70.3' },
  { name: 'IRONMAN 70.3 Edinburgh',     distance: '70.3' },
  { name: 'Ironman 70.3 Texas',         distance: '70.3' },  // case mismatch
];

console.log(`Total calibration sample: ${totalCalibrationSampleSize().toLocaleString()} finishes\n`);

for (const p of probes) {
  const res = lookupEmpiricalCourseFactors(p.name, p.distance, baseSec);
  if (!res) {
    console.log(`  ❌ ${p.distance.padEnd(7)} ${p.name}: no match`);
    continue;
  }
  const fmt = (m: number): string => (m < 1 ? '' : '+') + ((m - 1) * 100).toFixed(1) + '%';
  console.log(
    `  ✓  ${p.distance.padEnd(7)} ${p.name.padEnd(40)} swim ${fmt(res.swimMultiplier)}, bike ${fmt(res.bikeMultiplier)}, run ${fmt(res.runMultiplier)}  · n=${res.n} (${res.confidence})`,
  );
}
