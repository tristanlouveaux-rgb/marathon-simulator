/**
 * Smoke test — dataset-loader sanity check.
 * Run with: `npx tsx src/validation/smoke-test.ts`
 *
 * Confirms both loaders return well-formed records with realistic time
 * distributions. Not a proper test suite — just a quick eyeballing harness
 * before the full calibration runs against millions of rows.
 */

import { load703, loadIM, type FinishRecord } from './dataset-loader';

function summarise(name: string, records: FinishRecord[]): void {
  if (records.length === 0) {
    console.log(`${name}: 0 records (loader returned nothing)`);
    return;
  }
  const finishes = records.map((r) => r.finishSec).sort((a, b) => a - b);
  const median = finishes[Math.floor(finishes.length / 2)];
  const p10 = finishes[Math.floor(finishes.length * 0.1)];
  const p90 = finishes[Math.floor(finishes.length * 0.9)];

  const fmt = (s: number): string => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const events = new Set(records.map((r) => r.eventLocation));
  const years = new Set(records.map((r) => r.eventYear));
  const fSwim = records.reduce((s, r) => s + r.swimSec / r.finishSec, 0) / records.length;
  const fBike = records.reduce((s, r) => s + r.bikeSec / r.finishSec, 0) / records.length;
  const fRun = records.reduce((s, r) => s + r.runSec / r.finishSec, 0) / records.length;

  console.log(`\n${name}:`);
  console.log(`  rows:        ${records.length.toLocaleString()}`);
  console.log(`  events:      ${events.size}`);
  console.log(`  years:       ${[...years].sort().join(', ')}`);
  console.log(`  finish p10/median/p90: ${fmt(p10)} / ${fmt(median)} / ${fmt(p90)}`);
  console.log(`  mean leg fractions: swim ${(fSwim * 100).toFixed(1)}%  bike ${(fBike * 100).toFixed(1)}%  run ${(fRun * 100).toFixed(1)}%`);
  console.log(`  (T1+T2 = ${((1 - fSwim - fBike - fRun) * 100).toFixed(1)}%)`);
}

async function main(): Promise<void> {
  console.log('Loading 70.3 dataset...');
  const r703 = await load703();
  summarise('70.3 (Half_Ironman_df6.csv)', r703);

  console.log('\nLoading IM dataset (slower — 240MB streamed)...');
  const rIM = await loadIM();
  summarise('IM (results.csv)', rIM);

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
