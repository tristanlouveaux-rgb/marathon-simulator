// Mosaic marketing video recorder — config-driven, cached, fast to iterate.
//
//   node marketing/record.mjs                  full build (captures any uncached scenes)
//   RECAPTURE=football node marketing/record.mjs    re-shoot only those scenes
//   RECAPTURE=all node marketing/record.mjs          re-shoot everything (after app code changes)
//   ASSEMBLE_ONLY=1 node marketing/record.mjs         no browser: re-time / reorder / re-bezel from cache (~30s)
//
// Three speed tiers because capture (Chromium screenshots) is the slow part:
//   • pacing / storyboard order / iPhone bezel  -> ASSEMBLE_ONLY (cache reused)
//   • one scene's on-screen content             -> RECAPTURE=<id>
//   • athlete profile (numbers on every screen) -> changes the cache key, re-shoots all
//
// Outputs: marketing/video/mosaic-iphone.mp4  (phone on dark bg; QuickTime/FCP)
//          marketing/video/mosaic-iphone.webm (floating phone, alpha; CapCut/DaVinci/Premiere)
//          marketing/video/_raw.mp4           (un-framed 1170x2532 walkthrough)
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { createRequire } from 'module';
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');

// ════════════════════════ ATHLETE PROFILE (edit me) ════════════════════════
// Changing anything here re-shoots every scene (the numbers appear app-wide).
const PROFILE = {
  name: 'Tristan',
  marathon: { name: 'Chicago Marathon', city: 'Chicago', country: 'USA' },
  vo2: 57,                 // pins VDOT/VO2max across stats, forecast, placement
  detectedWeeklyKm: 30,    // "Recent volume" + week-1 distance basis (drives baselineKm)
  athleteTier: 'trained',  // 'beginner'|'recreational'|'trained'|'performance'|'high_volume'
  // The hero cross-training session (synced-style, with distance + HR).
  football: { label: 'Football', durationSec: 6000, distanceM: 10200, avgHR: 150, maxHR: 182, rpe: 6, calories: 940 },
  // Scheduled recurring sports (drives planned weekly session count). Keep small.
  recurringSports: [{ sport: 'Soccer', durationMin: 90, frequency: 1, intensity: 'hard' }],
  // Forecast "You" sport-mix donut, from 8-week history (independent of the above).
  sportMix: {
    soccer: { avgSessionRawTSS: 110, sessionsPerWeek: 1 },
    cycling: { avgSessionRawTSS: 55, sessionsPerWeek: 1 },
    swimming: { avgSessionRawTSS: 35, sessionsPerWeek: 1 },
  },
};

// ════════════════════════ STORYBOARD (edit me) ════════════════════════
// id: cache key + RECAPTURE target.  view: which screen.  pre/post: hold seconds.
// frac: how far down to scroll (0..1).  scroll: scroll duration seconds (0 = no scroll).
// Re-timing/reordering is free (ASSEMBLE_ONLY=1) — capture resolution is fixed.
const STORYBOARD = [
  { id: 'home1',       view: 'home',        label: 'home',              pre: 2.2, scroll: 0 },
  { id: 'sleep',       view: 'sleep',       label: 'sleep',             pre: 1.3, frac: 0.55, scroll: 3.5, post: 0.8 },
  { id: 'football',    view: 'football',    label: 'football-session',  pre: 1.4, frac: 0.50, scroll: 3.0, post: 0.8 },
  { id: 'adapt',       view: 'adapt',       label: 'replace-reduce',    pre: 4.0, scroll: 0 },
  { id: 'recovery',    view: 'recovery',    label: 'physiology',        pre: 1.3, frac: 0.60, scroll: 3.5, post: 0.8 },
  { id: 'readiness',   view: 'readiness',   label: 'readiness',         pre: 1.6, frac: 0.92, scroll: 6.5, post: 1.0 },
  { id: 'placement',   view: 'placement',   label: 'athlete-placement', pre: 1.8, frac: 0.70, scroll: 4.0, post: 1.0 },
  { id: 'forecastYou', view: 'forecastYou', label: 'sport-mix',         pre: 1.4, frac: 0.70, scroll: 3.5, post: 1.0 },
  { id: 'forecast',    view: 'forecast',    label: 'marathon-forecast', pre: 1.4, frac: 0.60, scroll: 3.5, post: 0.8 },
  { id: 'plan',        view: 'plan',        label: 'plan-week',         pre: 1.4, frac: 0.50, scroll: 3.0, post: 0.8 },
  { id: 'stats',       view: 'stats',       label: 'stats',             pre: 1.4, frac: 0.60, scroll: 3.0, post: 0.8 },
  { id: 'home2',       view: 'home',        label: 'home-end',          pre: 2.0, scroll: 0 },
];

// ════════════════════════ HYROX MODE ════════════════════════
const HYROX_PROFILE = {
  name: 'Tristan',
  previousHyroxTimeSec: 3300,          // ~55:00
  hyroxRunPaceSecKm: 215,              // ~3:35/km race pace -> forecast ~59:25 (sub-1hr)
  stationSplits: { ski_erg: 200, sled_push: 150, sled_pull: 165, burpee_broad_jumps: 240, row_erg: 195, farmer_carry: 90, sandbag_lunges: 175, wall_balls: 240 },
  vo2: 57,
};
const HYROX_STORYBOARD = [
  { id: 'hxHome',     view: 'home',        label: 'hyrox-home',     pre: 2.2, scroll: 0 },
  { id: 'hxForecast', view: 'hxForecast',  label: 'hyrox-forecast', pre: 1.6, frac: 0.92, scroll: 6.5, post: 1.0 },
  { id: 'hxStats',    view: 'hxStats',     label: 'hyrox-stats',    pre: 1.4, frac: 0.85, scroll: 5.0, post: 0.8 },
  { id: 'hxPlan',     view: 'hxPlan',      label: 'hyrox-plan',     pre: 1.4, frac: 0.70, scroll: 4.0, post: 0.8 },
];

// ════════════════════════ TRIATHLON MODE ════════════════════════
const TRI_PROFILE = {
  name: 'Tristan',
  cssSecPer100m: 108,                  // -> ~2:19/100m race swim (~44 min)
  ftp: 295, cda: 0.42, bikeWeightKg: 8, bodyWeightKg: 76,  // CdA 0.42 (upright) -> ~33.6 km/h at race watts
  runVdot: 47,
  skillRating: { swim: 2, bike: 3, run: 3 },   // Recreational
  pastRaceTotalSec: 19500,             // ~5:25 prior 70.3
  planWeeks: 20, currentWeek: 7,       // mid-plan -> progression chart + "narrows to race day"
  goalSec: 19236,                      // 5:20:36 goal -> goal line + chance-of-beating
  eventId: '703-ohio',                 // IRONMAN 70.3 Ohio (Sandusky) -> venue + course factor
};
const TRI_STORYBOARD = [
  { id: 'triHome',     view: 'home',        label: 'tri-home',      pre: 2.2, scroll: 0 },
  { id: 'triForecast', view: 'triForecast', label: 'tri-forecast',  pre: 1.6, frac: 1.0, scroll: 8.5, post: 1.0 },
  { id: 'triFitness',  view: 'triFitness',  label: 'tri-fitness',   pre: 1.4, frac: 0.85, scroll: 4.5, post: 0.8 },
  { id: 'triPlan',     view: 'triPlan',     label: 'tri-plan',      pre: 1.4, frac: 0.70, scroll: 4.0, post: 0.8 },
  { id: 'triStats',    view: 'triStats',    label: 'tri-stats',     pre: 1.4, frac: 0.80, scroll: 4.5, post: 0.8 },
];

// ════════════════════════ MODE SELECT ════════════════════════
const MODE = (process.env.MODE || 'running').trim();
const BOARD = MODE === 'hyrox' ? HYROX_STORYBOARD : MODE === 'triathlon' ? TRI_STORYBOARD : STORYBOARD;
const HASH_INPUT = MODE === 'hyrox' ? JSON.stringify(HYROX_PROFILE) : MODE === 'triathlon' ? JSON.stringify(TRI_PROFILE) : JSON.stringify(PROFILE);
// ════════════════════════════════════════════════════════════════════════════

const FPS = 24, XFADE = 0.35, SCR_W = 1170, SCR_H = 2532, SCROLL_STEPS = 48;
const VIDEO_DIR = 'marketing/composites', RAW = `${VIDEO_DIR}/_raw.mp4`;
const TMP = 'marketing/.tmp';
const PROFILE_HASH = createHash('md5').update(HASH_INPUT).digest('hex').slice(0, 10);
const CACHE = `marketing/.cache/${MODE}-${PROFILE_HASH}`;  // per-mode+profile screenshot cache
const FRAME_PNG = `marketing/.cache/iphone-frame.png`;   // geometry-only, profile-independent
// Buckets: clips/<mode>/ holds both .webm + .mov; stills/<mode>/ the PNGs. (running/hyrox/triathlon)
const CLIPS_DIR = `marketing/clips/${MODE}`;
const STILLS_DIR = `marketing/stills/${MODE}`;

const ASSEMBLE_ONLY = !!process.env.ASSEMBLE_ONLY;
const RECAPTURE = (process.env.RECAPTURE || '').split(',').map(s => s.trim()).filter(Boolean);
const RECAPTURE_ALL = RECAPTURE.includes('all');

mkdirSync(VIDEO_DIR, { recursive: true });
mkdirSync(CACHE, { recursive: true });
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// iPhone frame geometry
const MARGIN = 70, BEZEL = 26 * 3;
const BODY_W = SCR_W + BEZEL * 2, BODY_H = SCR_H + BEZEL * 2;
const CAN_W = BODY_W + MARGIN * 2, CAN_H = BODY_H + MARGIN * 2;

// Output canvas + phone placement (so every clip/still has the phone at the
// IDENTICAL size + position — drop into CapCut at 100%, no resizing).
const OUT_W = 1080, OUT_H = 1920;     // vertical (TikTok/Reels)
const PHONE_H_FRAC = 0.60;            // phone height as a fraction of frame height (tweak this)
const PHONE_H = Math.round(OUT_H * PHONE_H_FRAC);
const PHONE_W = Math.round(BODY_W * (PHONE_H / BODY_H));
const PAD = 24;                                            // gap from the frame edge
const POS_X = OUT_W - PHONE_W - PAD;                       // top-RIGHT corner
const POS_Y = PAD;
const scrX = MARGIN + BEZEL, scrY = MARGIN + BEZEL, islW = 360, islH = 96;
const FRAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${CAN_W}" height="${CAN_H}">
  <defs><mask id="h"><rect width="${CAN_W}" height="${CAN_H}" fill="white"/><rect x="${scrX}" y="${scrY}" width="${SCR_W}" height="${SCR_H}" rx="96" fill="black"/></mask></defs>
  <rect x="${MARGIN}" y="${MARGIN}" width="${BODY_W}" height="${BODY_H}" rx="150" fill="#0b0b0d" mask="url(#h)"/>
  <rect x="${(CAN_W - islW) / 2}" y="${scrY + 40}" width="${islW}" height="${islH}" rx="${islH / 2}" fill="#0b0b0d"/>
</svg>`;
const ease = (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

// ───────────────────────── capture (Chromium) ─────────────────────────
async function captureScenes(scenes) {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/supabase|strava|fetch|40\d/i.test(m.text())) console.log('ERR:', m.text().slice(0, 140)); });

  // Runs before any app script on EVERY load (incl. our page.reload): enter
  // simulator mode pre-boot (skips the auth/restore path that navigates) and
  // neutralise app-initiated navigation so it can't destroy the capture.
  await page.addInitScript(() => {
    try { localStorage.setItem('mosaic_simulator_mode', '1'); } catch { /* */ }
    try { window.location.reload = () => {}; } catch { /* */ }
    try { window.location.assign = () => {}; } catch { /* */ }
    try { window.location.replace = () => {}; } catch { /* */ }
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(3500);              // let first boot fully settle

  if (MODE === 'hyrox') {
    const hok = await page.evaluate(async (P) => {
      const { defaultOnboardingState } = await import('/src/types/onboarding.ts');
      const { initializeSimulator } = await import('/src/state/initialization.ts');
      const { updateState, getMutableState } = await import('/src/state/store.ts');
      const { saveState } = await import('/src/state/persistence.ts');
      const today = new Date(); const race = new Date(today); race.setDate(race.getDate() + 112);
      const onboarding = {
        ...defaultOnboardingState,
        name: P.name, trainingMode: 'hyrox', trainingForEvent: true,
        age: 34, biologicalSex: 'male', planDurationWeeks: 16,
        hyroxFormat: 'open_singles', previousHyroxTimeSec: P.previousHyroxTimeSec,
        hyroxPreviousStationSplits: P.stationSplits, hyroxRunPaceSecKm: P.hyroxRunPaceSecKm,
        hyroxSledAccess: 'always', hyroxHasSkiErg: true, hyroxHasRowErg: true,
        customRaceDate: race.toISOString().slice(0, 10), hasSmartwatch: true,
      };
      updateState({ onboarding });
      let res; try { res = initializeSimulator(onboarding); } catch (e) { return false; }
      const s = getMutableState();
      s.hasCompletedOnboarding = true; s.healthDisclaimerAcknowledged = true; s.guestBannerDismissed = true;
      if (s.onboarding) { s.onboarding.currentStep = 'main-view'; s.onboarding.skippedStrava = true; }
      const ph = [];
      for (let i = 20; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const wob = Math.sin(i * 0.7); const sleepSec = Math.round((7.4 + wob * 0.6) * 3600); ph.push({ date: d.toISOString().slice(0, 10), restingHR: Math.round(48 + wob * 2), maxHR: 191, hrvRmssd: Math.round(64 + wob * 8), vo2max: P.vo2, sleepScore: Math.round(82 + wob * 7), sleepDurationSec: sleepSec, sleepDeepSec: Math.round(sleepSec * 0.19), sleepRemSec: Math.round(sleepSec * 0.23), sleepLightSec: Math.round(sleepSec * 0.50), sleepAwakeSec: Math.round(sleepSec * 0.08), stressAvg: Math.round(30 + wob * 6), steps: Math.round(9000 + wob * 1500) }); }
      s.physiologyHistory = ph; s.restingHR = ph[ph.length - 1].restingHR;
      s.vo2 = P.vo2; s.skippedStrava = true;
      // initializeHyroxSimulator does NOT populate station benchmarks from the
      // onboarding splits, so the forecast falls back to slow band-seed times.
      // Set them directly (open_singles) + run pace -> sub-1hr forecast.
      if (s.hyroxConfig) { s.hyroxConfig.stationBenchmarksSingles = { ...P.stationSplits }; s.hyroxConfig.hyroxRunPaceSecKm = P.hyroxRunPaceSecKm; }
      saveState(); return !!(res && res.success) && !!s.hyroxConfig;
    }, HYROX_PROFILE);
    if (!hok) { await browser.close(); throw new Error('hyrox seed failed'); }
    await page.reload();
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const st = document.createElement('style');
      st.textContent = `*,*::before,*::after{animation-duration:0.001s!important;animation-delay:0s!important;transition-duration:0.001s!important;transition-delay:0s!important}`;
      document.head.appendChild(st);
      try { window.location.reload = () => {}; } catch { /* */ }
    });
  } else if (MODE === 'triathlon') {
    const tok = await page.evaluate(async (P) => {
      const { defaultOnboardingState } = await import('/src/types/onboarding.ts');
      const { initializeSimulator } = await import('/src/state/initialization.ts');
      const { updateState, getMutableState } = await import('/src/state/store.ts');
      const { saveState } = await import('/src/state/persistence.ts');
      const today = new Date(); const race = new Date(today); race.setDate(race.getDate() + 112);
      const prev = new Date(today); prev.setMonth(prev.getMonth() - 3);
      const onboarding = {
        ...defaultOnboardingState,
        name: P.name, trainingMode: 'triathlon', trainingForEvent: true,
        age: 34, biologicalSex: 'male', planDurationWeeks: P.planWeeks,
        triDistance: '70.3', triTimeAvailableHoursPerWeek: 10, selectedTriathlonId: P.eventId,
        triBike: { ftp: P.ftp, ftpSource: 'user', hasPowerMeter: true, bikeWeightKg: P.bikeWeightKg },
        triPastRace: { distance: '70.3', dateISO: prev.toISOString().slice(0, 10), totalSec: P.pastRaceTotalSec, perLeg: { swim: 2640, bike: 9600, run: 6540 }, source: 'manual' },
        customRaceDate: race.toISOString().slice(0, 10), hasSmartwatch: true,
      };
      updateState({ onboarding });
      let res; try { res = initializeSimulator(onboarding); } catch (e) { return false; }
      const s = getMutableState();
      s.hasCompletedOnboarding = true; s.healthDisclaimerAcknowledged = true; s.guestBannerDismissed = true;
      if (s.onboarding) { s.onboarding.currentStep = 'main-view'; s.onboarding.skippedStrava = true; }
      s.bodyWeightKg = P.bodyWeightKg; s.skippedStrava = true;
      s.w = P.currentWeek;                              // land mid-plan (week 7 of 20)
      s.raceGoalTimeSec = P.goalSec;                    // goal line + chance-of-beating
      s.v = P.runVdot; s.vo2 = P.runVdot; s.vo2Override = { value: P.runVdot, setAt: new Date().toISOString() };
      // initializeTriathlonSimulator leaves per-discipline pace markers unset
      // (forecast => NaN) and the bike falls back to a slow linear fit. Set CSS,
      // FTP, skill sliders, and a real aero profile + body/bike mass so the
      // power-balance physics fires -> believable sub-5hr half-iron.
      const t = s.triConfig;
      if (t) {
        t.skillRating = P.skillRating;
        t.swim = { cssSecPer100m: P.cssSecPer100m, cssSource: 'user' };
        t.bike = { ...(t.bike || {}), ftp: P.ftp, hasPowerMeter: true, bikeWeightKg: P.bikeWeightKg, courseProfile: 'flat',
          aeroProfiles: [{ id: 'road', label: 'Road bike (clip-ons)', position: 'clip-ons', cda: P.cda, cdaSource: 'calibrated', crr: 0.0040, tire: 'race-clincher', drivetrainEff: 0.97, airDensityKgM3: 1.225 }] };
      }
      const ph = [];
      for (let i = 20; i >= 0; i--) { const d = new Date(today); d.setDate(d.getDate() - i); const wob = Math.sin(i * 0.7); const sleepSec = Math.round((7.4 + wob * 0.6) * 3600); ph.push({ date: d.toISOString().slice(0, 10), restingHR: Math.round(48 + wob * 2), maxHR: 191, hrvRmssd: Math.round(64 + wob * 8), vo2max: P.runVdot, sleepScore: Math.round(82 + wob * 7), sleepDurationSec: sleepSec, sleepDeepSec: Math.round(sleepSec * 0.19), sleepRemSec: Math.round(sleepSec * 0.23), sleepLightSec: Math.round(sleepSec * 0.50), sleepAwakeSec: Math.round(sleepSec * 0.08), stressAvg: Math.round(30 + wob * 6), steps: Math.round(9000 + wob * 1500) }); }
      s.physiologyHistory = ph; s.restingHR = ph[ph.length - 1].restingHR;
      saveState(); return !!(res && res.success) && !!s.triConfig;
    }, TRI_PROFILE);
    if (!tok) { await browser.close(); throw new Error('triathlon seed failed'); }
    await page.reload();
    await page.waitForTimeout(2500);
    // Re-pin AFTER reload: main.ts recomputes s.v (degrades it to ~35 from thin
    // history) and may refresh markers, so the per-leg paces + VDOT chip drift.
    // Re-applying here makes the forecast hold the intended numbers.
    await page.evaluate((P) => {
      return import('/src/state/index.ts').then(({ getMutableState, saveState }) => {
        const s = getMutableState();
        s.v = P.runVdot; s.vo2 = P.runVdot; s.vo2Override = { value: P.runVdot, setAt: new Date().toISOString() };
        s.bodyWeightKg = P.bodyWeightKg; s.w = P.currentWeek; s.raceGoalTimeSec = P.goalSec; s.athleteTier = 'recreational';
        const t = s.triConfig;
        if (t) {
          t.targetFinishTimeSec = P.goalSec;            // tri goal field -> goal line + chance-of-beating
          t.skillRating = P.skillRating;
          t.swim = { cssSecPer100m: P.cssSecPer100m, cssSource: 'user' };
          t.bike = { ...(t.bike || {}), ftp: P.ftp, hasPowerMeter: true, bikeWeightKg: P.bikeWeightKg, courseProfile: 'flat',
            aeroProfiles: [{ id: 'road', label: 'Road bike (clip-ons)', position: 'clip-ons', cda: P.cda, cdaSource: 'calibrated', crr: 0.0040, tire: 'race-clincher', drivetrainEff: 0.97, airDensityKgM3: 1.225 }] };
        }
        saveState();
        const st = document.createElement('style');
        st.textContent = `*,*::before,*::after{animation-duration:0.001s!important;animation-delay:0s!important;transition-duration:0.001s!important;transition-delay:0s!important}`;
        document.head.appendChild(st);
        try { window.location.reload = () => {}; } catch { /* */ }
      });
    }, TRI_PROFILE);
  } else {
  const ok = await page.evaluate(async (P) => {
    localStorage.setItem('mosaic_simulator_mode', '1');
    const demo = await import('/src/state/demo-data.ts'); if (!demo.seedReviewerDemo()) return false;
    const { getMutableState, saveState } = await import('/src/state/index.ts');
    const matcher = await import('/src/calculations/activity-matcher.ts');
    const s = getMutableState();
    s.healthDisclaimerAcknowledged = true;
    s.guestBannerDismissed = true;            // hide the "Sign in to back up" hero card
    if (s.onboarding) s.onboarding.name = P.name;
    s.recurringActivities = P.recurringSports;
    const today = new Date(); const wk = s.wks?.[s.w - 1];
    const ph = [];
    for (let i = 20; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i); const wob = Math.sin(i * 0.7);
      const sleepSec = Math.round((7.4 + wob * 0.6) * 3600);
      ph.push({ date: d.toISOString().slice(0, 10), restingHR: Math.round(48 + wob * 2), maxHR: 191, hrvRmssd: Math.round(64 + wob * 8), vo2max: P.vo2, sleepScore: Math.round(82 + wob * 7), sleepDurationSec: sleepSec, sleepDeepSec: Math.round(sleepSec * 0.19), sleepRemSec: Math.round(sleepSec * 0.23), sleepLightSec: Math.round(sleepSec * 0.50), sleepAwakeSec: Math.round(sleepSec * 0.08), stressAvg: Math.round(30 + wob * 6), steps: Math.round(9000 + wob * 1500) });
    }
    s.physiologyHistory = ph; s.restingHR = ph[ph.length - 1].restingHR;
    const runs = []; const mk = (da, km, sec) => { const d = new Date(today); d.setDate(d.getDate() - da); d.setHours(7, 0, 0, 0); runs.push({ startTime: d.toISOString(), distKm: km, durSec: sec, activityType: 'RUNNING', avgHR: 150 }); };
    mk(4, 32, 10800); mk(11, 30, 10080); mk(18, 28, 9600); mk(2, 12, 3300); mk(6, 14, 3900); mk(9, 10, 2700); mk(13, 16, 4500);
    s.onboardingRunHistory = runs;
    const f = P.football; const start = new Date(today); start.setHours(11, 0, 0, 0);
    const id = `garmin-marketing-football`;
    matcher.addAdhocWorkoutFromPending(wk, { garminId: id, activityType: 'SOCCER', appType: 'cross', startTime: start.toISOString(), durationSec: f.durationSec, distanceM: f.distanceM, avgPaceSecKm: null, avgHR: f.avgHR, maxHR: f.maxHR, aerobicEffect: null, anaerobicEffect: null, garminRpe: f.rpe, calories: f.calories, iTrimp: null, hrZones: { z1: 540, z2: 1620, z3: 2160, z4: 1320, z5: 360 } }, id, f.rpe);
    if (!wk.rated) wk.rated = {}; wk.rated[id] = f.rpe;
    saveState(); return true;
  }, PROFILE);
  if (!ok) { await browser.close(); throw new Error('seed failed'); }

  await page.reload();
  await page.waitForTimeout(2500);

  await page.evaluate(async (P) => {
    const { getMutableState, saveState } = await import('/src/state/index.ts');
    const s = getMutableState();
    s.vo2Override = { value: P.vo2, setAt: new Date().toISOString() };
    s.v = P.vo2; s.vo2 = P.vo2; s.athleteTier = P.athleteTier;
    s.skippedStrava = true; if (s.onboarding) s.onboarding.skippedStrava = true;
    s.sportBaselineByType = P.sportMix;
    s.historicWeeklyRawTSS = [340, 360, 330, 380, 350, 370, 340, 360];
    s.historicWeeklyTSS = [300, 320, 290, 340, 310, 330, 300, 320];
    s.detectedWeeklyKm = P.detectedWeeklyKm;
    if (s.selectedMarathon) Object.assign(s.selectedMarathon, P.marathon);
    if (s.onboarding?.selectedRace) Object.assign(s.onboarding.selectedRace, P.marathon);
    const { refreshBlendedFitness } = await import('/src/calculations/blended-fitness.ts');
    refreshBlendedFitness(s); saveState();
    const st = document.createElement('style');
    st.textContent = `*,*::before,*::after{animation-duration:0.001s!important;animation-delay:0s!important;transition-duration:0.001s!important;transition-delay:0s!important}`;
    document.head.appendChild(st);
    // Neutralise app-initiated reloads (auth/session events fire window.location.reload
    // a few seconds after load, which destroys the capture mid-scene). The one reload
    // we need already happened; from here capture must own the page.
    try { window.location.reload = () => {}; } catch { /* read-only on some engines; best effort */ }
  }, PROFILE);
  }

  const render = (view) => page.evaluate(async (view) => {
    const mod = {
      sleep: () => import('/src/ui/sleep-view.ts').then(m => m.renderSleepView()),
      recovery: () => import('/src/ui/recovery-view.ts').then(m => m.renderRecoveryView()),
      readiness: () => import('/src/ui/readiness-view.ts').then(m => m.renderReadinessView()),
      home: () => import('/src/ui/home-view.ts').then(m => m.renderHomeView()),
      plan: () => import('/src/ui/plan-view.ts').then(m => m.renderPlanView()),
      forecast: () => import('/src/ui/race-forecast-view.ts').then(m => m.renderRaceForecastView()),
      stats: () => import('/src/ui/stats-view.ts').then(m => m.renderStatsView()),
      hxForecast: () => import('/src/ui/hyrox/forecast-view.ts').then(m => m.renderHyroxForecastView()),
      hxPlan: () => import('/src/ui/hyrox/plan-view.ts').then(m => m.renderHyroxPlanView()),
      hxStats: () => import('/src/ui/hyrox/stats-view.ts').then(m => m.renderHyroxStatsView()),
      triForecast: () => import('/src/ui/triathlon/forecast-view.ts').then(m => m.renderTriathlonForecastView()),
      triFitness: () => import('/src/ui/triathlon/fitness-detail-view.ts').then(m => m.renderTriFitnessDetailView()),
      triPlan: () => import('/src/ui/triathlon/plan-view.ts').then(m => m.renderTriathlonPlanView()),
      triStats: () => import('/src/ui/triathlon/stats-view.ts').then(m => m.renderTriathlonStatsView()),
      forecastYou: () => import('/src/ui/forecast-chip-detail-view.ts').then(m => m.renderForecastChipDetail('you')),
      placement: async () => { const { getState } = await import('/src/state/index.ts'); const r = await import('/src/ui/wizard/steps/review.ts'); r.renderReview(document.getElementById('app-root'), getState().onboarding); },
      football: async () => {
        const { getMutableState } = await import('/src/state/index.ts');
        const ad = await import('/src/ui/activity-detail.ts');
        const s = getMutableState();
        const wk = s.wks?.[s.w - 1];
        const hit = Object.entries(wk?.garminActuals ?? {}).find(([, a]) => (a.activityType || '').toUpperCase() === 'SOCCER');
        if (hit) ad.renderActivityDetail(hit[1], 'Football', 'home', undefined, hit[0]);
      },
      adapt: async () => {
        // The replace/reduce suggestion modal over the plan — exactly the
        // canonical "+ Log activity" pipeline (createActivity -> popup -> modal).
        const { getMutableState } = await import('/src/state/index.ts');
        const s = getMutableState();
        await import('/src/ui/plan-view.ts').then(m => m.renderPlanView());
        const ct = await import('/src/cross-training/index.ts');
        const { resolveWeekWorkouts } = await import('/src/ui/week-resolve.ts');
        const f = ({"durationMin":100,"rpe":6});
        const workouts = resolveWeekWorkouts(s, s.w);
        const weekRuns = ct.workoutsToPlannedRuns(workouts.filter(w => w.t !== 'cross' && w.t !== 'gym'), s.pac);
        const activity = ct.createActivity('soccer', f.durationMin, f.rpe, undefined, undefined, s.w);
        activity.hrZones = { z1: 540, z2: 1620, z3: 2160, z4: 1320, z5: 360 };  // HR-derived (matches the football detail), not "estimated from RPE"
        const popup = ct.buildCrossTrainingPopup({ raceGoal: s.rd, plannedRunsPerWeek: s.rw, injuryMode: false, easyPaceSecPerKm: s.pac?.e, runnerType: s.typ }, weekRuns, activity);
        const { showSuggestionModal } = await import('/src/ui/suggestion-modal.ts');
        showSuggestionModal(popup, 'soccer', () => {});
      },
    };
    await mod[view]();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = []; let n; while ((n = w.nextNode())) nodes.push(n);
    for (const nd of nodes) if (nd.nodeValue && /soccer/i.test(nd.nodeValue)) nd.nodeValue = nd.nodeValue.replace(/Soccer/g, 'Football').replace(/soccer/g, 'football');
  }, view);
  // Scroll the element that actually overflows (some detail views scroll an
  // inner container, not #app-root) by picking the largest scrollable node.
  const setScroll = (frac, eased) => page.evaluate(({ frac, eased }) => {
    const root = document.getElementById('app-root');
    const cands = [root, document.scrollingElement, document.body, ...(root ? root.querySelectorAll('*') : [])].filter(Boolean);
    let best = null, bestMax = 0;
    for (const el of cands) { const m = el.scrollHeight - el.clientHeight; if (m > bestMax) { bestMax = m; best = el; } }
    if (best) best.scrollTop = bestMax * frac * eased;
  }, { frac, eased });

  for (const sc of scenes) {
    const dir = `${CACHE}/${sc.id}`;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(`${dir}/scroll`, { recursive: true });
    // Clear stray body-level overlays (e.g. the 'adapt' suggestion modal) so a
    // modal from a previous scene can't bleed onto this one — views render into
    // #app-root, but modals append to <body> and persist otherwise.
    await page.evaluate(() => {
      for (const el of Array.from(document.body.children)) {
        if (el.id === 'app-root' || ['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName)) continue;
        if (getComputedStyle(el).position === 'fixed' || /modal|overlay|toast|backdrop/i.test(el.id || '')) el.remove();
      }
    });
    await render(sc.view);
    await setScroll(0, 0);
    await page.waitForTimeout(1500);                 // settle JS rings/bars
    await page.screenshot({ path: `${dir}/render.png` });
    const frac = sc.frac ?? 0;
    // Capture one screenshot per PLAYBACK frame, at its real eased scroll position
    // (1:1, no resampling) so the scroll is perfectly smooth. Scene's scroll
    // duration is baked here — changing `scroll` requires RECAPTURE of that scene.
    const scrollFrames = (sc.scroll ?? 0) > 0 && frac > 0 ? Math.max(1, Math.round(sc.scroll * FPS)) : 0;
    for (let i = 0; i < scrollFrames; i++) {
      const eased = ease(scrollFrames <= 1 ? 1 : i / (scrollFrames - 1));
      await setScroll(frac, eased);
      await page.screenshot({ path: `${dir}/scroll/${String(i).padStart(4, '0')}.png` });
    }
    writeFileSync(`${dir}/meta.json`, JSON.stringify({ view: sc.view, frac, scrollFrames }));
    console.log(`  captured ${sc.id}`);
  }
  await browser.close();
}

// ───────────────────────── assemble one scene -> segment mp4 ─────────────────────────
function assembleSegment(sc) {
  const dir = `${CACHE}/${sc.id}`;
  if (!existsSync(`${dir}/render.png`)) throw new Error(`scene "${sc.id}" not in cache — run without ASSEMBLE_ONLY first`);
  const seqDir = `${TMP}/seq-${sc.id}`; mkdirSync(seqDir, { recursive: true });
  let idx = 0;
  const put = (src) => copyFileSync(src, `${seqDir}/f${String(idx++).padStart(5, '0')}.png`);
  const secF = (s) => Math.max(0, Math.round((s ?? 0) * FPS));
  const render = `${dir}/render.png`;
  const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8'));
  const scrollFrames = meta.scrollFrames ?? 0;
  for (let i = 0; i < secF(sc.pre ?? 1.2); i++) put(render);             // pre-hold
  let lastScroll = render;
  for (let j = 0; j < scrollFrames; j++) {                                // scroll: captured frames 1:1 (smooth)
    lastScroll = `${dir}/scroll/${String(j).padStart(4, '0')}.png`;
    put(lastScroll);
  }
  for (let i = 0; i < secF(sc.post ?? 0); i++) put(lastScroll);          // post-hold
  const seg = `${TMP}/seg-${sc.id}.mp4`;
  execFileSync(ffmpeg, ['-y', '-framerate', String(FPS), '-i', `${seqDir}/f%05d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'veryfast', seg], { stdio: 'ignore', timeout: 300000 });
  return { file: seg, dur: idx / FPS };
}

async function genFramePng() {
  if (existsSync(FRAME_PNG)) return;
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const ctx = await browser.newContext({ viewport: { width: CAN_W, height: CAN_H }, deviceScaleFactor: 1 });
  const fp = await ctx.newPage();
  await fp.setContent(`<body style="margin:0">${FRAME_SVG}</body>`);
  await fp.screenshot({ path: FRAME_PNG, omitBackground: true });
  await browser.close();
}

// Composite a 1170x2532 source clip inside the iPhone frame -> opaque mp4 + alpha webm.
function compositeOne(src, base) {
  console.log(`compositing ${base} (opaque mp4)...`);
  execFileSync(ffmpeg, ['-y', '-i', src, '-loop', '1', '-i', FRAME_PNG, '-filter_complex',
    `color=c=0x0e0e12:s=${CAN_W}x${CAN_H}:r=${FPS}[bg];[0:v]scale=${SCR_W}:${SCR_H}[app];[bg][app]overlay=${scrX}:${scrY}:shortest=1[a];[a][1:v]overlay=0:0:shortest=1[out]`,
    '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', '-preset', 'veryfast', '-movflags', '+faststart',
    `${VIDEO_DIR}/${base}.mp4`], { stdio: 'ignore', timeout: 900000 });
  console.log(`compositing ${base} (alpha webm)...`);
  execFileSync(ffmpeg, ['-y', '-i', src, '-loop', '1', '-i', FRAME_PNG, '-filter_complex',
    `color=c=black@0.0:s=${CAN_W}x${CAN_H}:r=${FPS},format=yuva420p[bg];[0:v]scale=${SCR_W}:${SCR_H},format=yuva420p[app];[bg][app]overlay=${scrX}:${scrY}:format=auto:shortest=1[a];[a][1:v]overlay=0:0:format=auto:shortest=1[out]`,
    '-map', '[out]', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-threads', '8',
    `${VIDEO_DIR}/${base}.webm`], { stdio: 'ignore', timeout: 900000 });
}

// Per-scene clip: phone placed top-right on a fixed OUT_WxOUT_H TRANSPARENT canvas
// at identical size/position across every clip. Alpha webm — drop in at 100%.
// out ending .mov -> ProRes 4444 alpha (CapCut honors this; webm VP9 alpha it does NOT).
function compositeClip(src, out) {
  const filt = `color=c=black@0.0:s=${CAN_W}x${CAN_H}:r=${FPS},format=yuva420p[bg];[0:v]scale=${SCR_W}:${SCR_H},format=yuva420p[app];[bg][app]overlay=${scrX}:${scrY}:format=auto:shortest=1[a];[a][1:v]overlay=0:0:format=auto:shortest=1[b];[b]crop=${BODY_W}:${BODY_H}:${MARGIN}:${MARGIN},scale=${PHONE_W}:${PHONE_H},pad=${OUT_W}:${OUT_H}:${POS_X}:${POS_Y}:color=black@0.0[out]`;
  const codec = out.endsWith('.mov')
    ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
    : ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-threads', '8'];
  execFileSync(ffmpeg, ['-y', '-i', src, '-loop', '1', '-i', FRAME_PNG, '-filter_complex', filt, '-map', '[out]', ...codec, out], { stdio: 'ignore', timeout: 600000 });
}

// Transparent, phone-cropped PNG still per scene.
function exportStills() {
  const dir = STILLS_DIR;
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  BOARD.forEach((sc, i) => {
    const src = `${CACHE}/${sc.id}/render.png`;
    if (!existsSync(src)) return;
    const out = `${dir}/${String(i + 1).padStart(2, '0')}-${sc.label ?? sc.id}.png`;
    execFileSync(ffmpeg, ['-y', '-i', src, '-i', FRAME_PNG, '-filter_complex',
      `color=c=black@0.0:s=${CAN_W}x${CAN_H},format=rgba[bg];[0:v]scale=${SCR_W}:${SCR_H},format=rgba[app];[bg][app]overlay=${scrX}:${scrY}[a];[a][1:v]overlay=0:0[b];[b]crop=${BODY_W}:${BODY_H}:${MARGIN}:${MARGIN},scale=${PHONE_W}:${PHONE_H},pad=${OUT_W}:${OUT_H}:${POS_X}:${POS_Y}:color=black@0.0[out]`,
      '-map', '[out]', '-frames:v', '1', out], { stdio: 'ignore', timeout: 120000 });
  });
  console.log(`stills -> ${dir}/ (${BOARD.length} transparent PNGs)`);
}

// ───────────────────────── run ─────────────────────────
console.log(`MODE=${MODE} (${BOARD.length} scenes)`);
if (!ASSEMBLE_ONLY) {
  const toCapture = BOARD.filter(sc => RECAPTURE_ALL || RECAPTURE.includes(sc.id) || !existsSync(`${CACHE}/${sc.id}/render.png`));
  if (toCapture.length) {
    console.log(`capturing ${toCapture.length} scene(s): ${toCapture.map(s => s.id).join(', ')}`);
    await captureScenes(toCapture);
  } else {
    console.log('all scenes cached — nothing to capture (ASSEMBLE_ONLY would do the same, faster).');
  }
}

console.log('assembling segments...');
const segs = BOARD.map(assembleSegment);
await genFramePng();

// DEFAULT OUTPUT: one small transparent iPhone clip per scene (see-through corners) + stills.
const clipsDir = CLIPS_DIR;
if (existsSync(clipsDir)) rmSync(clipsDir, { recursive: true, force: true });
mkdirSync(clipsDir, { recursive: true });
const only = (process.env.CLIPS || '').split(',').map(s => s.trim()).filter(Boolean);
const EXT = process.env.MOV ? 'mov' : 'webm';   // MOV=1 -> ProRes 4444 (CapCut-safe alpha); default webm (small, DaVinci/Premiere)
BOARD.forEach((sc, i) => {
  if (only.length && !only.includes(sc.id)) return;
  console.log(`clip ${sc.id}...`);
  compositeClip(segs[i].file, `${clipsDir}/${String(i + 1).padStart(2, '0')}-${sc.label ?? sc.id}.${EXT}`);
});
console.log(`clips -> ${clipsDir}/ (transparent iPhone ${EXT}, fixed-canvas top-right)`);

exportStills();

// Optional single long walkthrough with crossfades (LONG=1).
if (process.env.LONG) {
  console.log('building long walkthrough (xfade)...');
  const inputs = segs.flatMap(s => ['-i', s.file]);
  let filt = '', prev = '0:v', cum = segs[0].dur;
  for (let i = 1; i < segs.length; i++) {
    const off = (cum - XFADE).toFixed(3);
    const lbl = i === segs.length - 1 ? 'out' : `x${i}`;
    filt += `[${prev}][${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${off}[${lbl}];`;
    prev = lbl; cum = cum + segs[i].dur - XFADE;
  }
  execFileSync(ffmpeg, ['-y', ...inputs, '-filter_complex', filt.replace(/;$/, ''), '-map', '[out]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'veryfast', RAW], { stdio: 'ignore', timeout: 900000 });
  compositeOne(RAW, 'mosaic-iphone');
}

rmSync(TMP, { recursive: true, force: true });
console.log(`DONE -> ${CLIPS_DIR}/ + ${STILLS_DIR}/${process.env.LONG ? ' + video/mosaic-iphone.*' : ''}`);
