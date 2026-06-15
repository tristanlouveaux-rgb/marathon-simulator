// ════════════════════════════════════════════════════════════════════════════
//  Mosaic logo overlay recorder  (rings + wordmark lockup, mp4, blend-mode keyed)
//
//  Replicates the app launch-splash lockup: the concentric ring mark (from
//  public/favicon.svg) above the "Mosaic." wordmark (Inter 600, -0.01em). On
//  entrance the lockup fades up while expanding "sonar" ripple rings emanate
//  outward from the mark and fade out (the app's drift-ring motion), then it
//  holds on the static lockup.
//
//  mp4 / H.264 cannot carry transparency, so each animated clip is rendered on a
//  SOLID key colour and removed in the editor with a one-tap blend mode —
//
//    Logos/mosaic-logo-white-on-black-SCREEN.mp4    -> blend mode SCREEN
//                              (black vanishes; best over dark/busy footage)
//    Logos/mosaic-logo-black-on-white-MULTIPLY.mp4  -> blend mode MULTIPLY
//                              (white vanishes; best over light footage)
//
//  Plus transparent PNG stills (image alpha works everywhere, unlike video alpha):
//    mosaic-logo-white.png     white mark, transparent  (drop over dark footage)
//    mosaic-logo-black.png     brand-black mark, transparent (over light footage)
//
//  Run:  node marketing/record-wordmark.mjs
//
//  Tunables (env): TEXT=Mosaic.  FONT_PX=132  WEIGHT=600  RING_PX=300  GAP_PX=64
//                  W=1080  H=1920  FPS=30  FADE_MS=700  HOLD_MS=1600
//                  RIPPLE_MAX=2.4  RIPPLE_PEAK=0.45
//
//  Mirrors the capture+encode pipeline in marketing/record.mjs.
// ════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static');

// ─── Config ─────────────────────────────────────────────────────────────────
const TEXT    = process.env.TEXT   ?? 'Mosaic.';
const FONT_PX = Number(process.env.FONT_PX ?? 132);
const WEIGHT  = Number(process.env.WEIGHT ?? 600);
const RING_PX = Number(process.env.RING_PX ?? 300); // rendered size of the ring mark
const GAP_PX  = Number(process.env.GAP_PX ?? 64);   // gap between mark and wordmark
const W       = Number(process.env.W   ?? 1080);
const H       = Number(process.env.H   ?? 1920);
const FPS     = Number(process.env.FPS ?? 30);
const FADE_MS = Number(process.env.FADE_MS ?? 700);  // lockup fade-in + mark settle
const HOLD_MS = Number(process.env.HOLD_MS ?? 1600); // static hold after entrance
const RIPPLE_MAX  = Number(process.env.RIPPLE_MAX  ?? 2.4);  // how far ripples expand
const RIPPLE_PEAK = Number(process.env.RIPPLE_PEAK ?? 0.45); // ripple peak opacity
const BRAND_BLACK = '#1A1A1A'; // app wordmark + ring stroke colour

const VIDEO_DIR = 'marketing/Logos';
const TMP = `${VIDEO_DIR}/_logo_seq`;

// Two staggered ripple pings, each over RIPPLE_DUR ms, starting at these offsets.
const RIPPLE_DELAYS = [100, 550];
const RIPPLE_DUR = 1100;
const ENTRANCE_MS = Math.max(FADE_MS, Math.max(...RIPPLE_DELAYS) + RIPPLE_DUR);
const TOTAL = Math.round(((ENTRANCE_MS + HOLD_MS) / 1000) * FPS);
const MS_PER_FRAME = 1000 / FPS;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ease    = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic — calm settle

mkdirSync(VIDEO_DIR, { recursive: true });

// Ring mark from public/favicon.svg (viewBox 0 0 64; centre 32,32). currentColor
// lets one CSS colour drive strokes + dot per variant.
const RING_MARK = `<svg viewBox="0 0 64 64" width="${RING_PX}" height="${RING_PX}" style="display:block">
  <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="32" cy="32" r="9"/>
    <circle cx="32" cy="32" r="16" opacity="0.55"/>
    <circle cx="32" cy="32" r="23" opacity="0.28"/>
  </g>
  <circle cx="32" cy="32" r="3" fill="currentColor"/>
</svg>`;

// A single thin ripple ring, sized to the mark, centred and absolutely stacked.
const RIPPLE = (id) => `<svg id="${id}" viewBox="0 0 64 64" width="${RING_PX}" height="${RING_PX}"
  style="position:absolute;inset:0;transform-origin:center;opacity:0;will-change:transform,opacity">
  <circle cx="32" cy="32" r="23" fill="none" stroke="currentColor" stroke-width="2"/>
</svg>`;

const pageHtml = (color, bg, transparent) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;padding:0;background:${transparent ? 'transparent' : bg};}
  #stage{width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;background:${transparent ? 'transparent' : bg};}
  #lockup{display:flex;flex-direction:column;align-items:center;color:${color};opacity:0;}
  #ringwrap{position:relative;width:${RING_PX}px;height:${RING_PX}px;}
  #rings{position:absolute;inset:0;transform-origin:center;}
  #mark{
    font-family:'Inter',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;
    font-weight:${WEIGHT};font-size:${FONT_PX}px;letter-spacing:-0.01em;
    line-height:1;margin-top:${GAP_PX}px;-webkit-font-smoothing:antialiased;
  }
</style></head>
<body><div id="stage"><div id="lockup">
  <div id="ringwrap">${RIPPLE('ripple0')}${RIPPLE('ripple1')}<div id="rings">${RING_MARK}</div></div>
  <div id="mark">${TEXT}</div>
</div></div></body></html>`;

// Per-frame state, computed deterministically from elapsed ms (no wall-clock).
const applyFrame = (tMs) => page.evaluate(([t, fadeMs, rippleDelays, rippleDur, rippleMax, ripplePeak]) => {
  const c01 = (x) => Math.max(0, Math.min(1, x));
  const eo  = (x) => 1 - Math.pow(1 - x, 3);
  const fade = eo(c01(t / fadeMs));
  document.getElementById('lockup').style.opacity = String(fade);
  // Mark settles in with a clear expand (0.78 -> 1.0).
  document.getElementById('rings').style.transform = `scale(${0.78 + 0.22 * fade})`;
  // Each ripple expands outward and fades out.
  rippleDelays.forEach((d, i) => {
    const el = document.getElementById('ripple' + i);
    const rt = (t - d) / rippleDur;
    if (rt <= 0 || rt >= 1) { el.style.opacity = '0'; return; }
    const scale = 0.5 + (rippleMax - 0.5) * eo(rt);
    const appear = Math.min(rt / 0.12, 1);   // pop in fast
    el.style.opacity = String(appear * (1 - rt) * ripplePeak); // then fade as it grows
    el.style.transform = `scale(${scale})`;
  });
}, [tMs, FADE_MS, RIPPLE_DELAYS, RIPPLE_DUR, RIPPLE_MAX, RIPPLE_PEAK]);

const browser = await chromium.launch({
  executablePath: existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : undefined,
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

// ─── Animated blend-mode mp4s ───────────────────────────────────────────────
const MP4_VARIANTS = [
  { name: 'white-on-black-SCREEN',  color: '#FFFFFF',   bg: '#000000' }, // SCREEN removes black
  { name: 'black-on-white-MULTIPLY', color: BRAND_BLACK, bg: '#FFFFFF' }, // MULTIPLY removes white
];
for (const v of MP4_VARIANTS) {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  await page.setContent(pageHtml(v.color, v.bg, false), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready); // Inter loaded before any capture

  console.log(`[${v.name}] capturing ${TOTAL} frames...`);
  for (let i = 0; i < TOTAL; i++) {
    await applyFrame(i * MS_PER_FRAME);
    await page.screenshot({ path: `${TMP}/f${String(i + 1).padStart(5, '0')}.png` });
  }

  console.log(`[${v.name}] encoding mp4 (H.264)...`);
  execFileSync(ffmpeg, [
    '-y', '-framerate', String(FPS), '-i', `${TMP}/f%05d.png`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'veryfast',
    '-movflags', '+faststart',
    `${VIDEO_DIR}/mosaic-logo-${v.name}.mp4`,
  ], { stdio: 'ignore', timeout: 600000 });
}

// ─── Transparent PNG stills (fully-settled lockup, no ripple) ────────────────
const STILL_VARIANTS = [
  { name: 'white', color: '#FFFFFF' },
  { name: 'black', color: BRAND_BLACK },
];
for (const v of STILL_VARIANTS) {
  await page.setContent(pageHtml(v.color, '#FFFFFF', true), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await applyFrame(ENTRANCE_MS + HOLD_MS); // settled, ripples already faded
  await page.screenshot({ path: `${VIDEO_DIR}/mosaic-logo-${v.name}.png`, omitBackground: true });
}

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
await browser.close();

console.log(`\nDone. Wrote to ${VIDEO_DIR}/:
  mosaic-logo-white-on-black-SCREEN.mp4    set clip blend mode to SCREEN   (dark footage)
  mosaic-logo-black-on-white-MULTIPLY.mp4  set clip blend mode to MULTIPLY (light footage)
  mosaic-logo-white.png                    white mark, transparent still
  mosaic-logo-black.png                    black mark, transparent still`);
