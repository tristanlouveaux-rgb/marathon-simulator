# Marketing video recorder (`record.mjs`)

Generates an iPhone-framed walkthrough of the app for marketing videos, driven
by real app code (real render functions, real load math) over a seeded demo
athlete. Output is overlay-ready.

## Prereqs

- Dev server running: `npx vite` (serves on :5173)
- `ffmpeg-static` (already a devDependency) + Playwright's Chromium

## One command

```bash
node marketing/recorders/record.mjs
```

Produces:

| File | Use |
|------|-----|
| `video/mosaic-iphone.mp4`  | phone on a dark background — opens in QuickTime, imports to Final Cut |
| `video/mosaic-iphone.webm` | floating phone, **transparent background** (alpha) — overlay in CapCut / DaVinci / Premiere / After Effects |
| `video/_raw.mp4`           | un-framed 1170×2532 walkthrough (intermediate) |

## Editing — three speed tiers

Capture (Chromium screenshots) is the slow part, so it is cached per scene.

| You changed… | Run | Speed |
|---|---|---|
| Pacing, scene order, or the iPhone bezel | `ASSEMBLE_ONLY=1 node marketing/recorders/record.mjs` | ~30s, no browser |
| One scene's on-screen content | `RECAPTURE=football node marketing/recorders/record.mjs` | ~40s |
| The athlete profile (numbers shown everywhere) | `node marketing/recorders/record.mjs` | re-shoots all, ~4–5 min |
| App rendering code (a view changed) | `RECAPTURE=all node marketing/recorders/record.mjs` | re-shoots all |

`RECAPTURE` takes a comma list of scene `id`s (or `all`).

## What to edit (both at the top of `record.mjs`)

- **`PROFILE`** — the demo athlete: name, target marathon, VO2max, weekly volume,
  the hero football session, scheduled sports, and the forecast sport-mix donut.
  Any change here invalidates the screenshot cache (new numbers on every screen).
- **`STORYBOARD`** — the ordered scene list. Each scene: `view` (which screen),
  `pre`/`post` (hold seconds), `frac` (scroll depth 0–1), `scroll` (scroll seconds).
  Re-timing and reordering are free via `ASSEMBLE_ONLY=1`.

Available `view`s: `home`, `sleep`, `football`, `recovery`, `placement`,
`forecastYou`, `forecast`, `plan`, `stats`. Add more by extending the `render`
map in `captureScenes`.

## Notes

- The demo seed uses the app's real ingest (`addAdhocWorkoutFromPending`) and real
  render functions — nothing is hand-drawn HTML.
- Cache lives in `marketing/.cache/<profile-hash>/`. Safe to delete to force a clean re-shoot.
- "Football" is relabelled from the app's `Soccer` sport at capture time (demo-only).
- **CapCut needs ProRes, not webm.** CapCut flattens VP9-webm alpha to black. Run with `MOV=1` (e.g. `MOV=1 MODE=hyrox node marketing/recorders/record.mjs`) to emit transparent **ProRes 4444 `.mov`** instead — CapCut honors that alpha. webm (default) is small and fine for DaVinci/Premiere/After Effects. ProRes is ~70 MB/clip vs ~1 MB.
- After changing app rendering code, use `RECAPTURE=all` (the cache key only tracks `PROFILE`).

## Readiness deep-dive stills (`record-readiness.mjs`)

A separate, self-contained recorder for the **Readiness score** story — every key page
plus a high-vs-low demonstration. Stills (no video), iPhone-framed, **phone centred on a
dark background** (clean to view and share).

```bash
node marketing/recorders/record-readiness.mjs   # -> marketing/stills/readiness/
```

It seeds two calibrated states over the reviewer demo, landing the athlete mid-plan
(week 6 of 16) with a real 5-week training history so the fitness model produces a
genuine TSB/ACWR rather than the week-1 "building baseline" cap:

| State | How it's seeded | Result |
|---|---|---|
| **HIGH** | build then sharp 2-week taper + excellent sleep/HRV | Primed (75), fresh TSB, ACWR 0.34 — *"You're rested and safe. Full session."* |
| **LOW** | steady weeks then an acute load spike (ACWR ≈ 1.5), normal sleep/HRV | Ease Back / Manage Load (≈31), ACWR is the binding floor → Home **Adjust plan** button → the plan-reduction modal that downgrades the runs (*"9.0 km → 6.0 km"*) |

Output: `home`, `readiness` (top + scrolled cards), `freshness`, `physiology`, `load-ratio`
drill-downs for each state, plus the low-readiness **adjust-down modal**, and a tiled
`_contact-sheet.png` for quick review. All numbers are real (the load-ratio bar chart is
derived from the seeded weekly history, not synthetic).

Calibration levers live in `seedFn` at the top of the script (`HIGH_MIN/LOW_MIN` weekly
minutes, `HIGH_RPE/LOW_RPE`, and the physiology block). The score must be re-pinned
POST-RELOAD (`s.w = 6`, planStart, vo2/tier) — main.ts boot otherwise resets `s.w` to 1
and collapses the history.
