# Mosaic — Marketing carousels

8 Instagram carousel mockups, one per branded tile in the existing 9-tile grid (the 9th wordmark tile acts as the brand closer and is matched by the CTA slide that ends each carousel).

Each HTML file renders 7 slides at native Instagram carousel size (1080×1350). Open in a browser, screenshot each slide, post.

The "phone screens" inside the mockups use the real Mosaic design system — the same atmosphere gradients, ring backgrounds, glass cards, mountain skylines, palette and typography that the app itself uses. They look like screenshots because they're built from the same CSS.

---

## Files

| File | Theme | Demonstrates |
|---|---|---|
| `carousel-marathon.html` | Training for a Marathon | Plan view, race forecast with VDOT trend, plan rebalancing after a missed run |
| `carousel-hyrox.html` | Training for HYROX | Run/Station/Brick mix, tendon-load model with decay chart, race forecast with 16-row order |
| `carousel-ironman.html` | Training for an Ironman | Three-discipline plan, per-discipline fitness rings, race forecast with course factors |
| `carousel-recovery.html` | Learns How You Recover | Home readiness ring, sleep detail with cumulative debt outlook, coach card adjusting today |
| `carousel-all-counts.html` | All Fitness Counts | Multi-sport activity log, weekly load with sport split, plan adjusted for cross-training |
| `carousel-easy-run.html` | This Was My Easy Run | Strain detail with ring at 128%, leg-fatigue page with EIMD model, plan softens for tomorrow |
| `carousel-more-than-running.html` | More Than Running | Mode picker (5 modes), 52-week CTL across modes, plan rebuilt with carried-over fitness |
| `carousel-it-all-counted.html` | It All Counted | Year fitness curve with race markers, 52-week consistency heatmap, race outcome vs prediction |

---

## Shared design system

All carousels load `app-style.css` (the shared design system). It mirrors:
- `src/styles.css` — palette and typography
- `src/ui/page-flair.ts` — atmosphere gradients, ring backgrounds, sun glint
- `src/ui/sky-background.ts` — sky/mountain palettes (bronze for leg fatigue, coral for strain, indigo for sleep, mint for recovery)
- Real glass card spec (`rgba(255,255,255,0.78) + blur(16px) + 16px radius`)

Edit `app-style.css` once and all 8 carousels update.

Headlines on the cover and text slides use **Anton** (free Google Font) — the closest match to the bold compressed italic on your existing 9 tiles. If you have a Druk or Inter Display licence, swap the `@import` line in `app-style.css`.

---

## How to use

1. Open the HTML file in a browser. Each slide is a 1080×1350 frame stacked vertically against a dark backdrop so the slide edges are obvious.
2. Screenshot each slide. Three options:
   - **macOS Cmd+Shift+4** then drag around the slide. Fastest for one-off slides.
   - **Browser print → Save as PDF** (one slide per page, configured in CSS). Convert PDF pages to PNG with `sips` or any image tool.
   - **Browser screenshot extension** (e.g. "GoFullPage") captures the full page, then crop to slides.
3. In Instagram, create a carousel post. Upload the 7 slides in order. The CTA is always slide 7.

### Recommended: use your existing tile as slide 1

Slide 1 in each carousel is a placeholder cover styled like your existing 9 tiles, in case you want a self-contained file. **For best brand fit, replace it with your real tile** when posting to Instagram — keep the grid you've already built, and use the HTML for slides 2–7.

---

## Editing copy or numbers

Open the HTML in any editor. Search for the slide-label comment (e.g. `<!-- SLIDE 3 -->`) and edit inline. The phone-screen contents are plain HTML — change a workout name, a TSS number, or a date in place. Refresh the browser to see the change.

---

## Editing visuals globally

`app-style.css` holds every colour and spacing rule. Common edits:
- **Cover background**: change `.cover.cover-warm`, `.cover.cover-dark`, etc.
- **Phone caption colour**: `.phone-caption` (size, weight)
- **Glass card opacity**: `.g-card` (background and blur)
- **Atmosphere palettes**: `.app-atmos`, `.app-atmos-mint`, `.app-atmos-bronze`, etc.

Each cover slide picks a `cover-*` class — variants: `cover-dark`, `cover-court`, `cover-stadium`, `cover-mountain`, `cover-warm`, `cover-gym`, `cover-coast`.

---

## Notes on fidelity

- The phone-screen mockups are **faithful reconstructions**, not live screenshots of the running app. They use the same CSS variables, ring SVG geometry, atmosphere gradients, and mountain skylines as the real app code. Layout decisions (header style, card spacing, ring sizing, pill shapes) are pulled directly from `src/ui/page-flair.ts`, `src/ui/sky-background.ts`, and `src/ui/home-view.ts`.
- Numbers and copy strings are illustrative — chosen to look like realistic app states. Swap them for your real data when you ship.
- For **Reels** (separate from Instagram feed), record the live app on a real iPhone and use Rotato or Arcade for motion. These HTML mockups are for static carousels only.

---

## Slide structure (consistent across all 8)

1. **Cover** (placeholder; swap with your existing branded tile)
2. **Hook** — bold italic headline + one-sentence sub
3. **Phone screen** #1 — a real app surface relevant to the theme
4. **Phone screen** #2 — a second surface that proves the claim
5. **Phone screen** #3 — the resulting plan change or insight
6. **Punchline** — bold italic closer, one-sentence sub
7. **CTA** — "Launching soon" + MOSAIC wordmark

This rhythm is intentional. Slide 2 sets up the question, slides 3–5 are the demo, slide 6 lands the answer, slide 7 closes. Instagram users swipe an average of 3.4 slides on a carousel — the demo lands inside that window.
