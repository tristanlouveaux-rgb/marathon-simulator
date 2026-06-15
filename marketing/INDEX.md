# Marketing assets — index & map

What lives where, and where each story's assets are. Updated after the 2026-06-10 reorg.

## Buckets (top level)

| Folder | What's in it |
|--------|--------------|
| `recorders/` | The generator scripts + their doc. `record.mjs` (main walkthrough), `record-readiness.mjs` (readiness deep-dive stills), `record-wordmark.mjs` (logo overlays), `RECORDER.md`. Run from the **repo root**, e.g. `node marketing/recorders/record.mjs`. |
| `clips/` | Animated app walkthrough clips, by mode: `clips/running/`, `clips/hyrox/`, `clips/triathlon/` (each holds the **`.webm`** small/DaVinci + **`.mov`** ProRes-alpha/CapCut side by side), plus `clips/readiness/` — **smooth top-to-bottom scroll clips** of the content-rich readiness deep-dive pages. All clips share ONE overlay framing: phone at 60% height, top-right corner, **transparent** (`.webm` + `.mov`, no mp4 — transparency needs alpha). Drop into CapCut at 100% and every phone matches. |
| `stills/` | Still PNGs, by mode: `stills/running/`, `stills/hyrox/`, `stills/triathlon/`, and `stills/readiness/` (the readiness deep-dive — see below). All transparent, phone top-right (same overlay framing as the clips). |
| `Logos/` | Brand wordmark/logo overlays (rings + "Mosaic." lockup). White/black transparent PNGs + blend-mode MP4s. See "Logos" below. |
| `composites/` | iPhone-framed videos: `mosaic-iphone.mp4/.webm` (phone-in-frame walkthrough), `clip-readiness.mp4/.webm`, `_raw.mp4` (un-framed source). |
| `carousels/` | Instagram/social carousel HTML pages (`carousel-*.html`) + their shared `app-style.css`. |
| `posters/` | Poster/key-art JPGs (`poster-readiness.jpg`). |
| `shots/` | Loose one-off screenshots and proofs (working scratch — not a curated set). |
| `zips/` | Export bundles for sharing (`mosaic-clips*.zip`, `mosaic-stills.zip`). Regenerable. |
| `captions/` | Smaller home-readiness stills for video captions (phone scaled down, top-right, transparent). Regenerate: `CAPTION=1 CAPTION_STATE=high CAPTION_FRAC=0.45 node marketing/recorders/record-readiness.mjs`. |
| `.cache/`, `.tmp/` | Recorder screenshot cache + scratch. Safe to delete to force a clean re-shoot. |

## Where is X — story map

| Story / topic | Where |
|---------------|-------|
| **Readiness — "should I push or not?"** | Stills: `stills/readiness/` — `high-*` = Primed ("push, full session"), `low-*` = Ease Back (load spike → downgrade). **Scroll videos** of the rich deep-dive pages: `clips/readiness/`. Animated intro: `composites/clip-readiness.*`. Poster: `posters/poster-readiness.jpg`. |
| **Readiness composite parts (deep-dives)** | Each its own captured page — `stills/readiness/`: strain (`*-strain`), physiology (`high-05-physiology`), freshness (`*-freshness`), sleep (`high-07-sleep`), rolling-load (`high-08-rolling-load`), load ratio/ACWR (`low-05-load-ratio`), component cards (`*-readiness-cards`), and **leg-load** (`cross-01-leg-load`). Scroll videos for the long ones in `clips/readiness/`. |
| **Leg load (cross-training)** | `cross-01-leg-load` — seeded with genuine **hiking + ski-touring** load (not running) so the page reads "Leg Fatigue 77, Heavy" with the ski tour + hikes in the decay timeline and Recent Sessions. A dedicated `cross` seed state (heavy leg load caps readiness, so it's kept off the high/low pages). |
| **Physiology** (sleep/HRV/recovery page) | `stills/readiness/high-05-physiology.png` (it's the recovery view). Walkthrough clip: `clips/running/05-physiology.{webm,mov}`, still `stills/running/05-physiology.png`. |
| **Freshness / Form** | `stills/readiness/high-04-freshness.png`, `low-06-freshness.png`. |
| **Load ratio (ACWR / injury risk)** | `stills/readiness/low-05-load-ratio.png`. |
| **Readiness component cards** | `stills/readiness/high-03-readiness-cards.png`, `low-04-readiness-cards.png`. |
| **Sleep** | `clips/running/02-sleep.*`, `stills/running/02-sleep.png` (general; not a readiness-component deep-dive). |
| **Athlete placement / who-you-are** | `clips/running/07-athlete-placement.*`, `clips/running/Who you are as an athlete.mov`, `stills/running/07-athlete-placement.png`. |
| **Marathon forecast** | `clips/running/09-marathon-forecast.*`, `stills/running/09-marathon-forecast.png`. |
| **HYROX** | `clips/hyrox/`, `stills/hyrox/`. |
| **Triathlon** | `clips/triathlon/`, `stills/triathlon/`. |
| **Logos / wordmark** | `Logos/`. |

## Logos (`Logos/`)

The rings + "Mosaic." lockup with an expanding sonar-ripple entrance. mp4/H.264 has no alpha, so the
animated overlays use a solid key colour removed via a one-tap editor blend mode:

| File | Use |
|------|-----|
| `mosaic-logo-white-on-black-SCREEN.mp4` | Over **dark** footage → set clip blend mode to **Screen** (black drops out). |
| `mosaic-logo-black-on-white-MULTIPLY.mp4` | Over **light** footage → blend mode **Multiply** (white drops out). |
| `mosaic-logo-white.png` / `mosaic-logo-black.png` | Transparent stills (image alpha works everywhere) — drop straight on, no blend mode. |

Regenerate: `node marketing/recorders/record-wordmark.mjs` (tunables documented in the script header).

## Readiness deep-dive coverage

`record-readiness.mjs` captures every readiness composite part as its own page (HIGH "push" + LOW "ease back"):
**readiness score**, **component cards**, **strain**, **physiology** (recovery), **freshness**, **sleep**,
**leg-load**, **rolling-load**, **load ratio** (ACWR), **adjust modal**. Content-rich pages also get a
**smooth scroll video** in `clips/readiness/`; pages that fit on one screen (e.g. strain) are stills only
(the still already shows the whole page — the recorder auto-skips a pointless scroll).

**Deliberately NOT captured: MTL (MusculoTendon Load).** It's a HYROX stations/bricks metric and reads
`0.0` for a running athlete. To capture it meaningfully, add an `mtl` scene to a HYROX-seeded run, not
this running readiness set (the renderer is already wired in `record-readiness.mjs`).

To add a page: add a scene to the `SCENES` array in `recorders/record-readiness.mjs` (set `vid: true`
for a scroll video) with a `view` wired to the relevant `import('/src/ui/<view>.ts')` renderer, re-run.
