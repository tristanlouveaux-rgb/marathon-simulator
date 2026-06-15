// Readiness deep-dive stills recorder.
//
// Produces iPhone-framed PNG stills walking every key page of the Readiness score
// in TWO seeded states:
//   • HIGH  — Primed (rested + safe): "push, full session"
//   • LOW   — Ease Back (acute load spike): the Home ring's adjust button opens the
//             plan-reduction modal that downgrades the session.
//
//   node marketing/recorders/record-readiness.mjs
//
// Framing matches record.mjs's mode clips exactly: phone at 60% height, TOP-RIGHT
// corner, TRANSPARENT — drop into CapCut at 100% like the running/hyrox/tri clips.
// Output: marketing/stills/readiness/NN-label.png        (1080x1920, transparent, phone top-right)
//         marketing/stills/readiness/_contact-sheet.png  (all stills tiled, for review)
//         marketing/clips/readiness/NN-label.{webm,mov}   (smooth scroll, alpha; scenes with vid:true)
//
// Self-contained (does not touch record.mjs). Reuses the cached iPhone-frame PNG.
import { chromium } from 'playwright';
import { execFileSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, copyFileSync } from 'fs';
import { createRequire } from 'module';
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');

// ── iPhone frame geometry (identical to record.mjs so the bezel matches) ──
const SCR_W = 1170, SCR_H = 2532, FPS = 24;
const MARGIN = 70, BEZEL = 26 * 3;
const BODY_W = SCR_W + BEZEL * 2, BODY_H = SCR_H + BEZEL * 2;
const CAN_W = BODY_W + MARGIN * 2, CAN_H = BODY_H + MARGIN * 2;
const scrX = MARGIN + BEZEL, scrY = MARGIN + BEZEL;
const FRAME_PNG = 'marketing/.cache/iphone-frame.png';
// Output framing — IDENTICAL to record.mjs's mode clips: phone at 60% height,
// pinned TOP-RIGHT on a TRANSPARENT canvas, so every readiness asset composites
// in CapCut at 100% exactly like the running/hyrox/triathlon clips.
const OUT_W = 1080, OUT_H = 1920;
const PHONE_H = Math.round(OUT_H * 0.60);
const PHONE_W = Math.round(BODY_W * (PHONE_H / BODY_H));
const PAD = 24;
const POS_X = OUT_W - PHONE_W - PAD;   // top-RIGHT corner
const POS_Y = PAD;
const OUT_DIR = 'marketing/stills/readiness';
const VID_DIR = 'marketing/clips/readiness';   // smooth-scroll deep-dive clips (alpha webm + ProRes mov)
const VFPS = 30, SCROLL_SEC = 2.8;             // per-page scroll duration
// Device safe-area-inset-top the headless browser lacks. The frame's Dynamic Island
// covers the top ~45 CSS px of the screen; this inset clears sticky page headers.
const SAFE_TOP = 59;
// easeInOutCubic — smooth accelerate + decelerate at the ends of the scroll.
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ── Scenes: ordered by state so we seed each state only once. ──
const SCENES = [
  // HIGH — readiness is high, you can push.
  { id: 'h-home',          state: 'high', view: 'home',      label: 'high-01-home' },
  { id: 'h-readiness',     state: 'high', view: 'readiness', label: 'high-02-readiness', vid: true },
  { id: 'h-readiness-mid', state: 'high', view: 'readiness', label: 'high-03-readiness-cards', frac: 0.5 },
  { id: 'h-freshness',     state: 'high', view: 'freshness', label: 'high-04-freshness', vid: true },
  { id: 'h-physiology',    state: 'high', view: 'recovery',  label: 'high-05-physiology', vid: true },
  // HIGH — the rest of the readiness composite parts, each its own deep-dive page.
  { id: 'h-strain',        state: 'high', view: 'strain',      label: 'high-06-strain',       vid: true },
  { id: 'h-sleep',         state: 'high', view: 'sleep',       label: 'high-07-sleep',        vid: true },
  { id: 'h-rollingload',   state: 'high', view: 'rollingload', label: 'high-08-rolling-load', vid: true },
  // (MTL deep-dive omitted: MusculoTendon Load is a HYROX stations/bricks metric and reads 0.0
  //  for a running athlete. Add it to a HYROX-seeded capture, not this running readiness set.)
  // LOW — readiness is low, adjust the session down.
  { id: 'l-home',          state: 'low',  view: 'home',        label: 'low-01-home' },
  { id: 'l-adjust',        state: 'low',  view: 'adjustModal', label: 'low-02-adjust-modal' },
  { id: 'l-readiness',     state: 'low',  view: 'readiness',   label: 'low-03-readiness', vid: true },
  { id: 'l-readiness-mid', state: 'low',  view: 'readiness',   label: 'low-04-readiness-cards', frac: 0.5 },
  { id: 'l-loadratio',     state: 'low',  view: 'loadratio',   label: 'low-05-load-ratio', vid: true },
  { id: 'l-freshness',     state: 'low',  view: 'freshness',   label: 'low-06-freshness' },
  // LOW — strain spike is the "ease back" story; show the strain page in this state too.
  { id: 'l-strain',        state: 'low',  view: 'strain',      label: 'low-07-strain', vid: true },
  // CROSS — leg-load deep-dive driven by GENUINE hiking + ski-touring load (not running).
  { id: 'x-legload',       state: 'cross', view: 'legload',    label: 'cross-01-leg-load', vid: true },
];

// ── In-browser seed (calibrated in marketing/_probe-readiness.mjs). ──
function seedFn(STATE) {
  return (async () => {
    localStorage.setItem('mosaic_simulator_mode', '1');
    const demo = await import('/src/state/demo-data.ts'); if (!demo.seedReviewerDemo()) return null;
    const { getMutableState, saveState } = await import('/src/state/index.ts');
    const matcher = await import('/src/calculations/activity-matcher.ts');
    const s = getMutableState();
    s.healthDisclaimerAcknowledged = true; s.guestBannerDismissed = true; s.skippedStrava = true;
    const HIGH = STATE === 'high';
    const CURRENT_W = 6;
    s.w = CURRENT_W;
    const today = new Date();
    const planStart = new Date(today); planStart.setDate(planStart.getDate() - ((CURRENT_W - 1) * 7 + 4));
    planStart.setHours(12, 0, 0, 0);
    s.planStartDate = planStart.toISOString().slice(0, 10);

    const addRun = (wk, dayDate, durMin, rpe, key) => {
      const start = new Date(dayDate); start.setHours(7, 30, 0, 0);
      const id = `garmin-hist-${key}`;
      matcher.addAdhocWorkoutFromPending(wk, {
        garminId: id, activityType: 'RUNNING', appType: 'run', startTime: start.toISOString(),
        durationSec: durMin * 60, distanceM: durMin * 200, avgPaceSecKm: 300, avgHR: 145, maxHR: 170,
        aerobicEffect: null, anaerobicEffect: null, garminRpe: rpe, calories: durMin * 11, iTrimp: null, hrZones: null,
      }, id, rpe);
      if (!wk.rated) wk.rated = {}; wk.rated[id] = rpe;
    };
    // Cross-training injector. Hiking & skiing carry legLoadPerMin = 0.50 (sports.ts),
    // so durMin x 0.50 = raw leg load via the sport-rate path -> genuine leg fatigue.
    const addCross = (wk, dayDate, durMin, rpe, key, activityType, appType, distM, avgHR, maxHR) => {
      const start = new Date(dayDate); start.setHours(8, 0, 0, 0);
      const id = `garmin-hist-${key}`;
      matcher.addAdhocWorkoutFromPending(wk, {
        garminId: id, activityType, appType, startTime: start.toISOString(),
        durationSec: durMin * 60, distanceM: distM, avgPaceSecKm: Math.round((durMin * 60) / (distM / 1000)),
        avgHR, maxHR, aerobicEffect: null, anaerobicEffect: null, garminRpe: rpe,
        calories: durMin * 9, iTrimp: null, hrZones: null,
      }, id, rpe);
      if (!wk.rated) wk.rated = {}; wk.rated[id] = rpe;
    };

    // CROSS — a dedicated leg-load showcase: leg fatigue from hiking + ski touring,
    // not running. Heavy cross-training leg load would cap readiness, so this state
    // is used ONLY for the leg-load page (never home/readiness).
    if (STATE === 'cross') {
      // Clear seedReviewerDemo's baseline runs so leg load is purely cross-training.
      (s.wks ?? []).forEach(w => { if (w) w.garminActuals = {}; });
      s.recentLegLoads = [];
      const wk = s.wks?.[CURRENT_W - 1];
      const dAgo = (n) => { const x = new Date(today); x.setDate(x.getDate() - n); return x; };
      if (wk) {
        // (durMin x 0.50 = raw leg load) — a big ski tour plus two hikes across the week.
        addCross(wk, dAgo(1), 170, 5, 'hike-y',   'HIKING', 'hike', 12000, 134, 159); // hike yesterday  -> 85
        addCross(wk, dAgo(3), 250, 6, 'skitour',  'SKIING', 'ski',  15000, 142, 170); // ski tour 3d ago -> 125
        addCross(wk, dAgo(6), 130, 4, 'hike-old', 'HIKING', 'hike',  9000, 126, 151); // hike 6d ago     -> 65
      }
      const phc = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i); const wob = Math.sin(i * 0.7);
        const sleepSec = Math.round(7.6 * 3600);
        phc.push({ date: d.toISOString().slice(0, 10), restingHR: Math.round(47 + wob * 1.5), maxHR: 191, hrvRmssd: Math.round(66 + wob * 4), vo2max: 53,
          sleepScore: Math.round(84 + wob * 3), sleepDurationSec: sleepSec, sleepDeepSec: Math.round(sleepSec * 0.19), sleepRemSec: Math.round(sleepSec * 0.23),
          sleepLightSec: Math.round(sleepSec * 0.5), sleepAwakeSec: Math.round(sleepSec * 0.08), stressAvg: Math.round(34 + wob * 6), steps: 9000 });
      }
      s.physiologyHistory = phc; s.restingHR = phc[phc.length - 1].restingHR;
      saveState();
      return s.planStartDate;
    }
    // HIGH: build then sharp taper -> fresh, positive TSB, ACWR < 1.
    // LOW : steady then acute spike -> ACWR ~1.5, the binding floor.
    const HIGH_MIN = [320, 350, 340, 210, 120, 40], HIGH_RPE = [4, 4, 4, 3, 3, 3];
    const LOW_MIN = [150, 150, 150, 165, 215, 260], LOW_RPE = [4, 4, 4, 4, 5, 6];
    const weeklyMin = HIGH ? HIGH_MIN : LOW_MIN, weeklyRpe = HIGH ? HIGH_RPE : LOW_RPE;
    for (let wi = 0; wi < CURRENT_W; wi++) {
      const wk = s.wks?.[wi]; if (!wk) continue;
      const wkStart = new Date(planStart); wkStart.setDate(wkStart.getDate() + wi * 7);
      const dayOffsets = [0, 1, 2, 3, 5];
      const happened = dayOffsets.filter(off => { const d = new Date(wkStart); d.setDate(d.getDate() + off); return d <= today; });
      if (happened.length === 0) continue;
      const per = Math.round(weeklyMin[wi] / happened.length);
      happened.forEach((off, si) => { const day = new Date(wkStart); day.setDate(day.getDate() + off); addRun(wk, day, per, weeklyRpe[wi], `${wi}-${si}`); });
    }
    const ph = [];
    for (let i = 27; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i); const wob = Math.sin(i * 0.7);
      let sleepScore, hrv, rhr, sleepH;
      if (HIGH) { sleepScore = Math.round(89 + wob * 3); hrv = Math.round(74 + wob * 4); rhr = Math.round(45 + wob * 1.5); sleepH = 7.9; }
      else { sleepScore = Math.round(75 + wob * 3); hrv = Math.round(59 + wob * 4); rhr = Math.round(49 + wob * 1.5); sleepH = 7.3; }
      const sleepSec = Math.round(sleepH * 3600);
      ph.push({ date: d.toISOString().slice(0, 10), restingHR: rhr, maxHR: 191, hrvRmssd: hrv, vo2max: 53, sleepScore,
        sleepDurationSec: sleepSec, sleepDeepSec: Math.round(sleepSec * 0.19), sleepRemSec: Math.round(sleepSec * 0.23),
        sleepLightSec: Math.round(sleepSec * 0.5), sleepAwakeSec: Math.round(sleepSec * 0.08), stressAvg: Math.round((HIGH ? 27 : 44) + wob * 6), steps: 9000 });
    }
    s.physiologyHistory = ph; s.restingHR = ph[ph.length - 1].restingHR;
    saveState();
    return s.planStartDate;
  })();
}

function repinFn({ planStart, safeTop }) {
  return (async () => {
    const { getMutableState, saveState } = await import('/src/state/index.ts');
    const s = getMutableState();
    s.w = 6; s.planStartDate = planStart;
    s.vo2Override = { value: 53, setAt: new Date().toISOString() }; s.v = 53; s.vo2 = 53; s.athleteTier = 'trained';
    const { refreshBlendedFitness } = await import('/src/calculations/blended-fitness.ts');
    refreshBlendedFitness(s); saveState();
    const st = document.createElement('style');
    // Anti-animation + the device safe-area-inset-top the headless browser lacks.
    // env(safe-area-inset-top) resolves to 0 with no notch, so the app's three
    // safe-area sites collapse and sticky page headers ("Today's Strain") render
    // flush at y=0 where the frame's Dynamic Island covers them. Reproduce the
    // device by overriding all three: body pushes content down, the .safe-top-bleed
    // wrapper bleeds the gradient back to y=0 (-safeTop) then re-insets its content
    // (+safeTop). Faithful to BounceViewController / on-device rendering.
    st.textContent = `*,*::before,*::after{animation-duration:0.001s!important;animation-delay:0s!important;transition-duration:0.001s!important;transition-delay:0s!important}`
      + `body{padding-top:${safeTop}px!important}`
      + `.mosaic-page,.safe-top-bleed{margin-top:-${safeTop}px!important;padding-top:${safeTop}px!important}`;
    document.head.appendChild(st);
    try { window.location.reload = () => {}; } catch { /* */ }
  })();
}

// ── Render a view (returns nothing; leaves DOM in #app-root + any modal on body). ──
function renderFn(view) {
  return (async () => {
    const mod = {
      home: () => import('/src/ui/home-view.ts').then(m => m.renderHomeView()),
      readiness: () => import('/src/ui/readiness-view.ts').then(m => m.renderReadinessView()),
      freshness: () => import('/src/ui/freshness-view.ts').then(m => m.renderFreshnessView()),
      recovery: () => import('/src/ui/recovery-view.ts').then(m => m.renderRecoveryView()),
      loadratio: () => import('/src/ui/injury-risk-view.ts').then(m => m.renderInjuryRiskView()),
      strain: () => import('/src/ui/strain-view.ts').then(m => m.renderStrainView()),
      sleep: () => import('/src/ui/sleep-view.ts').then(m => m.renderSleepView()),
      legload: () => import('/src/ui/leg-load-view.ts').then(m => m.renderLegLoadView()),
      rollingload: () => import('/src/ui/rolling-load-view.ts').then(m => m.renderRollingLoadView()),
      mtl: () => import('/src/ui/mtl-load-view.ts').then(m => m.renderMtlLoadView()),
      adjustModal: async () => {
        await import('/src/ui/home-view.ts').then(m => m.renderHomeView());
        await new Promise(r => setTimeout(r, 500));
        document.getElementById('readiness-adjust-btn')?.click();
        await new Promise(r => setTimeout(r, 1500));
      },
    };
    await mod[view]();
  })();
}

// The phone-in-frame compositing chain — phone scaled to PHONE_H and padded into the
// TOP-RIGHT corner of a TRANSPARENT OUT_WxOUT_H canvas (identical to record.mjs's mode
// clips, so every readiness asset drops into CapCut at 100% just like the rest).
// `pixfmt` = rgba for PNG stills, yuva420p for alpha video. r=VFPS locks the graph so
// the 1:1 captured frames are NOT resampled (ffmpeg's color default 25fps -> stutter).
const frameFilter = (pixfmt) =>
  `color=c=black@0.0:s=${CAN_W}x${CAN_H}:r=${VFPS},format=${pixfmt}[bg];[0:v]scale=${SCR_W}:${SCR_H},format=${pixfmt}[app];` +
  `[bg][app]overlay=${scrX}:${scrY}:format=auto:shortest=1[a];[a][1:v]overlay=0:0:format=auto:shortest=1[b];` +
  `[b]crop=${BODY_W}:${BODY_H}:${MARGIN}:${MARGIN},scale=${PHONE_W}:${PHONE_H},pad=${OUT_W}:${OUT_H}:${POS_X}:${POS_Y}:color=black@0.0[out]`;

// ── Composite a raw 1170x2532 screenshot -> TRANSPARENT PNG, phone top-right. ──
function frameStill(srcPng, outPng) {
  execFileSync(ffmpeg, ['-y', '-i', srcPng, '-i', FRAME_PNG, '-filter_complex', frameFilter('rgba'), '-map', '[out]', '-frames:v', '1', outPng], { stdio: 'ignore', timeout: 120000 });
}

// ── Same, but phone scaled to a custom height (for a smaller caption still). ──
function frameStillScaled(srcPng, outPng, phoneH) {
  const pw = Math.round(BODY_W * (phoneH / BODY_H));
  const posX = OUT_W - pw - PAD, posY = PAD;   // top-right, same inset as the set
  const filt = `color=c=black@0.0:s=${CAN_W}x${CAN_H},format=rgba[bg];[0:v]scale=${SCR_W}:${SCR_H},format=rgba[app];`
    + `[bg][app]overlay=${scrX}:${scrY}:format=auto:shortest=1[a];[a][1:v]overlay=0:0:format=auto:shortest=1[b];`
    + `[b]crop=${BODY_W}:${BODY_H}:${MARGIN}:${MARGIN},scale=${pw}:${phoneH},pad=${OUT_W}:${OUT_H}:${posX}:${posY}:color=black@0.0[out]`;
  execFileSync(ffmpeg, ['-y', '-i', srcPng, '-i', FRAME_PNG, '-filter_complex', filt, '-map', '[out]', '-frames:v', '1', outPng], { stdio: 'ignore', timeout: 120000 });
}

// ── Smooth-scroll video: capture one screenshot per playback frame at its real
//    eased scroll position (1:1, no resampling), then frame + encode ALPHA clips
//    (webm VP9 + ProRes mov), matching the mode-clip overlay format. ──
async function captureScrollVideo(page, sc, seqDir, outBase) {
  // Find the dominant scroller and its max scroll distance.
  const maxScroll = await page.evaluate(() => {
    const root = document.getElementById('app-root');
    const cands = [root, document.scrollingElement, document.body, ...(root ? root.querySelectorAll('*') : [])].filter(Boolean);
    let best = 0;
    for (const el of cands) { const m = el.scrollHeight - el.clientHeight; if (m > best) best = m; }
    return best;
  });
  if (maxScroll < 60) { console.log(`    (skip video ${sc.label}: page fits, nothing to scroll)`); return false; }

  rmSync(seqDir, { recursive: true, force: true }); mkdirSync(seqDir, { recursive: true });
  const frames = Math.max(2, Math.round(SCROLL_SEC * VFPS));
  for (let i = 0; i < frames; i++) {
    const top = maxScroll * easeIO(i / (frames - 1));
    await page.evaluate((y) => {
      const root = document.getElementById('app-root');
      const cands = [root, document.scrollingElement, document.body, ...(root ? root.querySelectorAll('*') : [])].filter(Boolean);
      let best = null, bestMax = 0;
      for (const el of cands) { const m = el.scrollHeight - el.clientHeight; if (m > bestMax) { bestMax = m; best = el; } }
      if (best) best.scrollTop = y;
    }, top);
    await page.screenshot({ path: `${seqDir}/f${String(i).padStart(5, '0')}.png` });
  }
  // Two ffmpeg passes from the same sequence: alpha webm (DaVinci/Premiere) + ProRes
  // mov (CapCut). -frames:v bounds the otherwise-infinite looped-frame source.
  const filt = frameFilter('yuva420p');
  execFileSync(ffmpeg, ['-y', '-framerate', String(VFPS), '-i', `${seqDir}/f%05d.png`, '-loop', '1', '-i', FRAME_PNG,
    '-filter_complex', filt, '-map', '[out]', '-frames:v', String(frames), '-r', String(VFPS),
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-threads', '8',
    `${outBase}.webm`], { stdio: 'ignore', timeout: 300000 });
  execFileSync(ffmpeg, ['-y', '-framerate', String(VFPS), '-i', `${seqDir}/f%05d.png`, '-loop', '1', '-i', FRAME_PNG,
    '-filter_complex', filt, '-map', '[out]', '-frames:v', String(frames), '-r', String(VFPS),
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
    `${outBase}.mov`], { stdio: 'ignore', timeout: 300000 });
  rmSync(seqDir, { recursive: true, force: true });
  return true;
}

// ── Run ──
// CAPTION=1 renders ONE smaller home-readiness still for a video caption and exits,
// without touching the main stills/clips set. CAPTION_STATE=high|low, CAPTION_FRAC=0.45.
const CAPTION = !!process.env.CAPTION;
if (!existsSync(FRAME_PNG)) { console.error('missing iphone-frame.png — run `node marketing/record.mjs` once first'); process.exit(1); }
if (!CAPTION) {
  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  if (existsSync(VID_DIR)) rmSync(VID_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(VID_DIR, { recursive: true });
}
const RAW = `${OUT_DIR}/.raw`; mkdirSync(RAW, { recursive: true });

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
const page = await ctx.newPage();
await page.addInitScript(() => {
  try { localStorage.setItem('mosaic_simulator_mode', '1'); } catch { /* */ }
  try { window.location.reload = () => {}; } catch { /* */ }
  try { window.location.assign = () => {}; } catch { /* */ }
  try { window.location.replace = () => {}; } catch { /* */ }
});
await page.goto('http://localhost:5173');
await page.waitForTimeout(3500);

if (CAPTION) {
  const state = process.env.CAPTION_STATE ?? 'high';
  const frac = Number(process.env.CAPTION_FRAC ?? 0.45);
  process.stdout.write(`caption: seeding ${state}... `);
  const planStart = await page.evaluate(seedFn, state);
  if (!planStart) { console.error('seed failed'); await browser.close(); process.exit(1); }
  await page.reload(); await page.waitForTimeout(2500);
  await page.evaluate(repinFn, { planStart, safeTop: SAFE_TOP });
  await page.evaluate(() => {
    for (const el of Array.from(document.body.children)) {
      if (el.id === 'app-root' || ['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName)) continue;
      if (getComputedStyle(el).position === 'fixed' || /modal|overlay|toast|backdrop/i.test(el.id || '')) el.remove();
    }
  });
  await page.evaluate(renderFn, 'home');
  await page.waitForTimeout(1400);
  await page.evaluate(() => { window.scrollTo(0, 0); const r = document.getElementById('app-root'); if (r) r.scrollTop = 0; if (document.scrollingElement) document.scrollingElement.scrollTop = 0; });
  await page.evaluate(() => document.getElementById('home-readiness-card')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(600);
  const raw = `${RAW}/caption.png`; await page.screenshot({ path: raw });
  mkdirSync('marketing/captions', { recursive: true });
  const out = `marketing/captions/readiness-home-${state}-${Math.round(frac * 100)}.png`;
  frameStillScaled(raw, out, Math.round(OUT_H * frac));
  rmSync(RAW, { recursive: true, force: true });
  await browser.close();
  console.log(`done -> ${out}`);
  process.exit(0);
}

const outputs = [];
let activeState = null;
for (const sc of SCENES) {
  if (sc.state !== activeState) {
    process.stdout.write(`seeding ${sc.state}... `);
    const planStart = await page.evaluate(seedFn, sc.state);
    if (!planStart) { console.error('seed failed'); await browser.close(); process.exit(1); }
    await page.reload();
    await page.waitForTimeout(2500);
    await page.evaluate(repinFn, { planStart, safeTop: SAFE_TOP });
    activeState = sc.state;
    console.log('ok');
  }
  // Clear any body-level modal/overlay bleed from a previous scene.
  await page.evaluate(() => {
    for (const el of Array.from(document.body.children)) {
      if (el.id === 'app-root' || ['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName)) continue;
      if (getComputedStyle(el).position === 'fixed' || /modal|overlay|toast|backdrop/i.test(el.id || '')) el.remove();
    }
  });
  await page.evaluate(renderFn, sc.view);
  await page.waitForTimeout(sc.view === 'adjustModal' ? 400 : 1400);   // settle rings/bars
  // Reset scroll to the top before capture — window scroll persists across scenes
  // (the home scrollIntoView leaves it ~117px down), which pins sticky page headers
  // under the Dynamic Island. home/frac scenes re-apply their own scroll below.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const r = document.getElementById('app-root'); if (r) r.scrollTop = 0;
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  });
  // Home: bring the Readiness ring (+ adjust button) into view — it sits below the
  // hero/today card. The modal scene keeps the modal centred regardless of scroll.
  if (sc.view === 'home') {
    await page.evaluate(() => document.getElementById('home-readiness-card')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
  }
  if (sc.frac) {
    await page.evaluate((frac) => {
      const root = document.getElementById('app-root');
      const cands = [root, document.scrollingElement, document.body, ...(root ? root.querySelectorAll('*') : [])].filter(Boolean);
      let best = null, bestMax = 0;
      for (const el of cands) { const m = el.scrollHeight - el.clientHeight; if (m > bestMax) { bestMax = m; best = el; } }
      if (best) best.scrollTop = bestMax * frac;
    }, sc.frac);
    await page.waitForTimeout(600);
  }
  const raw = `${RAW}/${sc.id}.png`;
  await page.screenshot({ path: raw });
  const out = `${OUT_DIR}/${sc.label}.png`;
  frameStill(raw, out);
  outputs.push(out);
  console.log(`  still ${sc.label}`);

  // Content-rich pages also get a smooth top-to-bottom scroll clip (alpha webm + mov).
  if (sc.vid) {
    await page.evaluate(() => { const r = document.getElementById('app-root'); if (r) r.scrollTop = 0; document.scrollingElement && (document.scrollingElement.scrollTop = 0); });
    await page.waitForTimeout(200);
    const ok = await captureScrollVideo(page, sc, `${RAW}/seq-${sc.id}`, `${VID_DIR}/${sc.label}`);
    if (ok) console.log(`  video ${sc.label}.{webm,mov}`);
  }
}
await browser.close();

// Contact sheet (tiled) for quick review. `tile` needs ONE multi-frame input, so
// stage the stills as a numbered sequence first.
const sheet = `${OUT_DIR}/_contact-sheet.png`;
try {
  const seqDir = `${RAW}/seq`; mkdirSync(seqDir, { recursive: true });
  outputs.forEach((o, i) => copyFileSync(o, `${seqDir}/s${String(i).padStart(2, '0')}.png`));
  const cols = 4, rows = Math.ceil(outputs.length / cols);
  execFileSync(ffmpeg, ['-y', '-i', `${seqDir}/s%02d.png`, '-vf',
    `scale=360:640,tile=${cols}x${rows}:padding=10:margin=10:color=0x141417`, '-frames:v', '1', sheet], { stdio: 'ignore', timeout: 120000 });
  console.log(`contact sheet -> ${sheet}`);
} catch (e) { console.log('contact sheet skipped:', e.message?.slice(0, 120)); }

rmSync(RAW, { recursive: true, force: true });
console.log(`\nDONE -> ${OUT_DIR}/ (${outputs.length} stills) + ${VID_DIR}/ (scroll videos)`);
