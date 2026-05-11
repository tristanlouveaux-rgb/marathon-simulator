/**
 * Captures screenshots of all screens showing Strava data.
 * Run: node scripts/strava-screenshots.js
 */

import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { mkdirSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URL = 'https://mosaic-theta-lac.vercel.app';
const OUT_DIR = join(__dirname, '../strava-screenshots');

async function shot(page, name) {
  const file = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  saved: ${name}.png`);
}

async function navigate(page, fnName, ...args) {
  await page.evaluate(
    ([fn, a]) => {
      const f = window[fn];
      if (f) f(...a);
      else console.warn('function not found:', fn);
    },
    [fnName, args]
  );
  await page.waitForTimeout(1800);
}

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  console.log('\nOpening app — log in if prompted, then press Enter here to continue...');
  await page.goto(APP_URL);
  await page.waitForTimeout(3000);

  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });

  console.log('\nCapturing screenshots...\n');

  await navigate(page, 'renderHomeView');
  await shot(page, '01-home-view');

  await navigate(page, 'renderPlanView');
  await shot(page, '02-plan-view');

  await navigate(page, 'renderStatsView');
  await shot(page, '03-stats-view');

  await navigate(page, 'renderAccountView');
  await shot(page, '04-account-view');

  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(500);
  await shot(page, '05-account-view-strava-section');

  await navigate(page, 'renderHomeView');
  await page.waitForTimeout(1000);
  const activityCard = await page.$('[data-garmin-id^="strava-"]');
  if (activityCard) {
    await activityCard.click();
    await page.waitForTimeout(2000);
    await shot(page, '06-activity-detail-strava');
  } else {
    console.log('  (no Strava activity card on home — skipping activity detail)');
  }

  await navigate(page, 'renderMatchingScreen');
  await shot(page, '07-matching-screen');

  console.log(`\nDone. ${readdirSync(OUT_DIR).length} screenshots saved to:\n  ${OUT_DIR}\n`);
  await browser.close();
})();
