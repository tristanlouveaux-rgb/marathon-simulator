/**
 * Calibration runner — load both datasets, build distribution tables and
 * empirical course factors, write JSON outputs that the runtime predictor
 * consumes.
 *
 * Run with: `NODE_OPTIONS='--max-old-space-size=4096' npx tsx src/validation/run-calibration.ts`
 *
 * Outputs (checked in):
 *   - src/constants/empirical-split-distributions.json
 *   - src/constants/empirical-course-factors.json
 *
 * Also prints a human-readable report with sample sizes, top hardest /
 * easiest courses, and any flagged anomalies.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { load703, loadIM } from './dataset-loader';
import { buildDistribution, type DistributionTable } from './distribution';
import { buildCourseFactors, type CourseFactorTable } from './course-factors';
import { buildTransitionTable, type TransitionTable } from './transition-distributions';

const OUT_DIR = resolve(process.cwd(), 'src/constants');

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

function reportDistribution(label: string, table: DistributionTable): void {
  console.log(`\n=== ${label} split-distribution table ===`);
  console.log(`  records: ${table.totalRecords.toLocaleString()}`);
  console.log(`  bins:    ${table.bins.length}`);
  console.log(`  centerSec | n     | swim%(SD) | bike%(SD) | run%(SD)`);
  for (const b of table.bins) {
    const fmt = (m: number, sd: number): string => `${(m * 100).toFixed(1)}±${(sd * 100).toFixed(1)}`;
    console.log(
      `  ${fmtTime(b.centerSec)} | ${b.n.toString().padStart(5)} | ${fmt(b.swimFracMean, b.swimFracSD).padEnd(10)}| ${fmt(b.bikeFracMean, b.bikeFracSD).padEnd(10)}| ${fmt(b.runFracMean, b.runFracSD)}`,
    );
  }
}

function reportCourseFactors(label: string, table: CourseFactorTable): void {
  console.log(`\n=== ${label} course factors (${Object.keys(table.factors).length} locations) ===`);
  console.log(`  reference times: swim ${fmtTime(table.referenceSwimSec)}, bike ${fmtTime(table.referenceBikeSec)}, run ${fmtTime(table.referenceRunSec)}`);

  const entries = Object.entries(table.factors);

  // Top 5 hardest bike (highest bikeFactor)
  const byBikeHard = [...entries].sort((a, b) => b[1].bikeFactor - a[1].bikeFactor).slice(0, 5);
  console.log(`\n  Top 5 hardest bike legs:`);
  for (const [loc, f] of byBikeHard) {
    console.log(`    ${loc.padEnd(45)} bike=${f.bikeFactor.toFixed(3)}  swim=${f.swimFactor.toFixed(3)}  run=${f.runFactor.toFixed(3)}  n=${f.n}  (${f.confidence})`);
  }

  // Top 5 easiest bike
  const byBikeEasy = [...entries].sort((a, b) => a[1].bikeFactor - b[1].bikeFactor).slice(0, 5);
  console.log(`\n  Top 5 easiest bike legs:`);
  for (const [loc, f] of byBikeEasy) {
    console.log(`    ${loc.padEnd(45)} bike=${f.bikeFactor.toFixed(3)}  swim=${f.swimFactor.toFixed(3)}  run=${f.runFactor.toFixed(3)}  n=${f.n}  (${f.confidence})`);
  }

  // Top 5 hardest run
  const byRunHard = [...entries].sort((a, b) => b[1].runFactor - a[1].runFactor).slice(0, 5);
  console.log(`\n  Top 5 hardest run legs:`);
  for (const [loc, f] of byRunHard) {
    console.log(`    ${loc.padEnd(45)} run=${f.runFactor.toFixed(3)}  bike=${f.bikeFactor.toFixed(3)}  swim=${f.swimFactor.toFixed(3)}  n=${f.n}  (${f.confidence})`);
  }

  // Confidence distribution
  const byConf: Record<string, number> = { high: 0, medium: 0, low: 0, insufficient: 0 };
  for (const [, f] of entries) byConf[f.confidence]++;
  console.log(`\n  Confidence: ${byConf.high} high, ${byConf.medium} medium, ${byConf.low} low`);
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

async function main(): Promise<void> {
  console.log('Loading 70.3...');
  const r703 = await load703();
  console.log(`  ${r703.length.toLocaleString()} 70.3 records`);

  console.log('Loading IM...');
  const rIM = await loadIM();
  console.log(`  ${rIM.length.toLocaleString()} IM records`);

  // Distributions
  const dist703 = buildDistribution('70.3', r703);
  const distIM  = buildDistribution('ironman', rIM);
  reportDistribution('70.3', dist703);
  reportDistribution('IM', distIM);

  // Course factors
  const cf703 = buildCourseFactors('70.3', r703);
  const cfIM  = buildCourseFactors('ironman', rIM);
  reportCourseFactors('70.3', cf703);
  reportCourseFactors('IM', cfIM);

  // Transition tables (per-event × level bin, with global fallback)
  const tt703 = buildTransitionTable('70.3', r703);
  const ttIM  = buildTransitionTable('ironman', rIM);
  reportTransitions('70.3', tt703);
  reportTransitions('IM', ttIM);

  // Write JSON outputs (compact)
  const distOut = resolve(OUT_DIR, 'empirical-split-distributions.json');
  ensureDir(distOut);
  writeFileSync(distOut, JSON.stringify({ '70.3': dist703, ironman: distIM }, null, 2));
  console.log(`\nWrote ${distOut}`);

  const cfOut = resolve(OUT_DIR, 'empirical-course-factors.json');
  ensureDir(cfOut);
  writeFileSync(cfOut, JSON.stringify({ '70.3': cf703, ironman: cfIM }, null, 2));
  console.log(`Wrote ${cfOut}`);

  const ttOut = resolve(OUT_DIR, 'empirical-transition-distributions.json');
  ensureDir(ttOut);
  writeFileSync(ttOut, JSON.stringify({ '70.3': tt703, ironman: ttIM }, null, 2));
  console.log(`Wrote ${ttOut}`);
}

function reportTransitions(label: string, table: TransitionTable): void {
  console.log(`\n=== ${label} transition table ===`);
  const locCount = Object.keys(table.byLocation).length;
  console.log(`  ${locCount} race locations with ≥${table.minRaceBinN}/bin`);
  console.log(`  ${table.global.length} global fallback bins (≥${table.minGlobalBinN}/bin)`);
  console.log(`  global per-bin avg transition (centerSec | n | T1+T2 | T1 | T2):`);
  for (const b of table.global) {
    const t1 = b.t1Mean !== undefined ? `${(b.t1Mean / 60).toFixed(1)}m` : '—';
    const t2 = b.t2Mean !== undefined ? `${(b.t2Mean / 60).toFixed(1)}m` : '—';
    const tr = `${(b.transitionMean / 60).toFixed(1)}m`;
    console.log(`    ${fmtTime(b.centerSec)} | ${b.n.toString().padStart(6)} | ${tr.padStart(6)} | ${t1.padStart(5)} | ${t2.padStart(5)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
