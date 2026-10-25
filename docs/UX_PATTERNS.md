# Mosaic UX Patterns

Design reference for UI components. Read this before building any new chart, bar, or data visualisation.

**Aesthetic target**: Variant UI warmth meets Garmin factual clarity. Each page has its own nature-themed background but shares a consistent card/type/chart system. Athletic, factual, no AI/wellness softness.

---

## Visual Constraints (Hard Rules — Read First)

These override all other aesthetic choices. Violating them produces "AI slop" output.

### Colour budget: 2 non-neutral colours maximum per component

Neutrals (free, don't count): `var(--c-text)`, `var(--c-muted)`, `var(--c-faint)`, `var(--c-border)`, `var(--c-border-strong)`, `var(--c-bg)`, `var(--c-surface)`.

Non-neutral colours that count toward the budget: `var(--c-accent)` (blue), `var(--c-ok)` (green), `var(--c-caution)` (amber), `var(--c-danger)` (red), and any hex value.

- **Do not solve a visual hierarchy problem by adding a new colour.** Use font-weight, font-size, or spacing instead.
- Never mix amber + blue + green in the same card or section.
- Status/alert cards (injury, illness) may use **one** semantic colour — not two.

### No decorative icons

Icons are only permitted where they **replace text entirely**:
- A checkmark `✓` in a status dot — fine
- A `›` chevron after a tappable value — fine
- SVG navigation arrows in `< >` nav buttons — fine

Never add:
- Sun / moon / flame / bolt / running-figure icons to convey mood or state
- Coloured icon boxes as visual anchors in cards (no `width:36px;height:36px;border-radius:10px;background:rgba(...)`)
- SVG arrows or chevrons that duplicate adjacent text (e.g. `→` after "Change")

### No tinted card backgrounds

Cards and rows use `var(--c-surface)` or `var(--c-bg)`. Do **not** set `background:rgba(N,N,N,0.N)` on a card unless it is a status-alert type explicitly defined in these patterns (the existing illness and injury banners). Do not introduce new tinted backgrounds.

### No decorative gradients on cards

`linear-gradient` is forbidden on cards and inline elements except in:
- Zone/fitness position bars (existing pattern, data-carrying)
- Area chart fills (existing pattern, data-carrying)
- The 3px accent stripe on illness/injury banners (existing only — do not add new ones)
- **Page backgrounds**: each detail page has its own SVG nature scene (see "Page Backgrounds" section). These are the only permitted decorative gradients.

### No ALL-CAPS on regular labels

`text-transform:uppercase` and heavy `letter-spacing` (>0.04em) on data labels make the UI look like a spreadsheet dashboard. Only use on phase badges (existing established pattern).

### When in doubt: do less

If a change requires adding a colour, an icon, a tinted background, or a gradient to "make it work", the design direction is wrong. Simplify instead.

---

## Zone / Position Bars

Used in: `buildOnePositionBar()` in `stats-view.ts`.

### Anatomy

```
Running Fitness                          29 · Foundation ›
████████████░░░░░│░░░░░░░│░░░░░░░│░░░░░░░│░░░░░░░░░░░░░
Building  Foundation  Trained  Well-Trained  Performance  Elite
```

| Layer | What it is | How |
|-------|-----------|-----|
| Background track | All zones visible as tinted segments | `display:flex`, fractions as `flex` values |
| Solid fill | Covers 0 → current position in zone colour | `position:absolute`, `width:${pct}%`, `z-index:2` |
| Divider ticks | 1.5px white lines at zone boundaries | `position:absolute`, `z-index:1` (sits under fill) |
| White gap | 3px notch at exact position | `position:absolute`, `z-index:4` |
| Zone labels | Centered under each segment | `position:absolute`, `left:${midPct}%`, `translateX(-50%)` |

### Rules

- **Bar height**: 14px, `border-radius:7px`, `overflow:hidden`
- **Labels**: 8px, faint for inactive zones; fill colour + bold for the active zone
- **Active zone label is the only coloured label** — don't colour the others
- **Overflow:hidden clips absolute children** — any element that must appear outside the bar (e.g. a triangle pointer above) needs a wrapper div with `position:relative` and `padding-top` to create space above the bar
- **Label row height**: `18px` with `position:relative` so `position:absolute` children don't collapse it
- **Chevron for drill-down**: SVG `›` icon, `stroke:var(--c-muted)`, inline after the value/zone label. Only shown when history data exists (> 3 points)
- **A bound is drawn as a bound.** When a position is known only as a bound (a rank past a coarse table's end, shown as "<25%"), draw the range it can be in, from the bar's end to the bound (`rgba(15,23,42,0.35)`), and a hollow marker at the bound (white fill, 2px slate-900 border); never a solid point. `fieldRankMarkerHtml` (`src/ui/hyrox/stats-view.ts:448`).

### Colour Spectrum (fitness/performance zones)

Use this progression for zones that go from low → high fitness or performance. Uses distinct blue/indigo shades — not a safety/traffic-light palette (red/green is reserved for risk or pass/fail scales only).

| Zone | Track (tinted bg) | Fill (active, solid) |
|------|------------------|---------------------|
| Building     | `rgba(56,189,248,0.18)`  | `#38BDF8` sky-400    |
| Foundation   | `rgba(59,130,246,0.20)`  | `#3B82F6` blue-500   |
| Trained      | `rgba(79,70,229,0.22)`   | `#4F46E5` indigo-600 |
| Well-Trained | `rgba(124,58,237,0.25)`  | `#7C3AED` violet-600 |
| Performance  | `rgba(147,51,234,0.28)`  | `#9333EA` purple-600 |
| Elite        | `rgba(109,40,217,0.35)`  | `#6D28D9` violet-700 |

**Why**: Six distinct blue→violet hues are immediately readable without implying that lower zones are "bad". Red/orange/green is reserved for safety/risk scales (Load Safety, injury risk, ACWR).

### Anti-patterns

- Do not use a fat vertical bar as the position marker — it gets clipped by `overflow:hidden` and looks heavy
- Do not show all zone labels at the same colour/weight — the active one must stand out
- Do not show only start/end labels if there are 4+ zones — show all, even if narrow zones overflow slightly
- Do not use opacity variations of a single hue for multi-zone scales

---

## Area Charts

Used in: Training Load, Running Distance, metric history sub-pages, Forecast.

### Rules

- **No dots on data points** — area charts only, clean line + fill
- **No "now" vertical line** — adds visual noise without value (exception: forecast split marker — see below)
- **Fill opacity**: `0.12–0.18` — light enough to not dominate
- **Stroke width**: `1.5px`
- **Y-axis labels**: absolute-positioned spans inside a relative wrapper, `8px`, `rgba(0,0,0,0.25)`, right-aligned
- **X-axis labels**: `9px`, `var(--c-faint)`, spaced by `buildWeekLabels()`
- **Trend colour**: green (`rgba(52,199,89,...)`) if rising/improving, red (`rgba(255,69,58,...)`) if declining. Applied to both stroke and fill.
- **Inverted metrics** (e.g. LT pace — lower is better): flip `yOf()` so improvement reads as upward on the chart

### Forecast continuation pattern

When a chart extends into planned/future data (e.g. Total Load → Forecast tab):
- **Same chart, same colour** — do not switch to bars or a new chart type
- **Historical portion**: solid fill (`opacity 0.18`) + solid stroke
- **Forecast portion**: lighter fill (`opacity 0.07`) + dashed stroke (`stroke-dasharray="4 3"`, opacity ~0.50)
- **Split marker**: thin dashed vertical line at "today" (`rgba(0,0,0,0.10)`)
- **Phase labels**: small text (`8px`, `rgba(0,0,0,0.25)`) below the date tick — one word per week (Base/Build/Peak/Taper). No coloured legend, no separate phase timeline component.

### Chart type rules

- **Use area charts** for all time-series load, distance, and fitness data.
- **Bar charts are banned** for time-series data. The only permitted uses for bars are: sleep stage breakdown rows, zone/position bars.
- **Never add bar charts** because "each week is a discrete unit" — weekly data still reads better as a continuous line.

### Empty state

When fewer than the required data points exist, **render nothing** — do not show an "empty state" card. Hide the entire section. The user doesn't need to be told data is missing; they just don't see the chart until there's enough signal.

---

## Drill-Down Sub-pages

### Pattern

Tapping a bar or card with a `›` chevron pushes a sub-page:
- `buildMetricSubHeader(title)` — back button + title, same structure as `buildDetailHeader()`
- Back button wired separately from the main detail back — goes to the parent detail page, not Stats summary
- Large current value display at top (`28–32px`, `font-weight:300`)
- Subtitle in `12px var(--c-faint)` explaining the metric
- Area chart in an `m-card`

### When to show the chevron

Only add `detailId` (and show the chevron) when > 3 history data points exist. Check at render time — don't show a drill-down that leads to an empty chart.

---

---

## Overlays and Modals

**Always use a vertically centered overlay**, not a bottom sheet. Bottom sheets sit behind the device keyboard on iOS and appear off-screen on desktop/tablet views.

### Canonical pattern

```html
<div class="fixed inset-0 z-50 flex items-center justify-center p-4"
     style="background:rgba(0,0,0,0.45)">
  <div class="w-full max-w-sm rounded-2xl p-5"
       style="background:var(--c-surface)">
    <!-- title, body, actions -->
  </div>
</div>
```

### Rules

- **Modal cards are white** (`var(--c-surface)` / `#fff`), never the warm page cream (`#FAF9F6` / `var(--c-bg)`). Cream is for full-page backgrounds; using it on a floating card makes the popup read as a different colour from every other modal. Inner recessed elements on the card (inputs, circular close buttons, recessed rows) may use `var(--c-bg)` — they read as a subtle recess on white. Raised stat tiles stay white and lift via their own shadow. (Swept app-wide 2026-06-15.)
- **Never use `items-end`** — bottom-anchored sheets look broken on desktop and are hard to dismiss on iOS.
- **Full-screen takeover overlays must pad for the status bar.** `position:fixed;inset:0` escapes the body's `padding-top: env(safe-area-inset-top)`, so any takeover with top-anchored content (a header with Cancel/Save, a column layout) renders under the iOS clock unless the overlay itself carries `padding-top:env(safe-area-inset-top, 0px)`. Centered modals are exempt (content can't reach the status bar). Atmosphere layers built with `position:absolute;inset:0` still bleed behind the status bar — absolute children span the padding box. Guarded by ui-lint rule `takeover-no-safe-top`. Real incident 2026-06-12: Match Activities header (Cancel/Save) buried behind the clock on device.
- Max width `max-w-sm` (384px) for input pickers; `max-w-lg` for detail sheets.
- Dismiss on backdrop click (`e.target === overlay → overlay.remove()`).
- Cancel button always present. Confirm/save action button below it, or built into each option.
- Padding: `p-5` on the card, `p-4` on the viewport wrapper (prevents edge-to-edge on small screens).

---

## Buttons

### Colour rules

- **Navigation and utility buttons** (jump to week, review, close, cancel, "Learn more →", "Breakdown →") use `var(--c-muted)` text on a transparent background, **no border, no colour**. Never accent-coloured.
- **`var(--c-accent)` is reserved for primary CTAs only** — a single, unambiguous action the user is being directed toward (e.g. "Start workout", "Save", "Confirm"). There should be at most one accent button visible at a time.
- **`var(--c-ok)` (green)** is for status indicators and success states, not buttons.
- Do not colour a button just because it relates to the "current" state — neutral is correct for navigation.
- **"Learn more", "Breakdown", secondary drill-down links**: always `var(--c-muted)`, never `var(--c-accent)`. They are navigation, not CTAs.

### Depth + press-in are the default (2026-06-15)

**Every action-button class carries a resting float shadow and an `:active` press-in.** Tristan's call ("remember this for all buttons"): a tap should feel physical everywhere. The full canonical set — use a class, never hardcode a fill:

| Class | Use for | Fill |
|-------|---------|------|
| `m-btn-primary` | primary CTA (Save, Complete Workout, Start) | dark `var(--c-black)` |
| `m-btn-secondary` | cancel / neutral / disabled-state | white `var(--c-surface)` + border |
| `m-btn-glass` (`--inset`) | tactile taps inside cards/modals | frosted white |
| `m-btn-ok` | positive action (Mark as done, Start Run, Accept, Add Activity) | green `var(--c-ok)` |
| `m-btn-caution` | caution action (Pause, Skip, Drop, Edit week) | amber `var(--c-caution)` |
| `m-btn-danger` | destructive (Stop, Discard, Delete) + anything that was `var(--c-warn)` red | red `#EF4444` |

For an enabled/disabled toggle button driven by JS, **swap the class** (`m-btn-ok` ↔ `m-btn-secondary`+`opacity:0.55`), do not rewrite `style.background` — an inline background overrides the class and kills the depth/press-in. Stateful selection toggles (a ternary that flips fill on select) are the one place to keep an inline conditional fill.

- `.m-btn-primary` (dark pill) and `.m-btn-secondary` (white pill) now have a resting float (`box-shadow` lift) and press in on `:active` (`translateY(0.5px) scale(0.985)`, shadow collapsing inward). `.m-btn-glass` already did. `.m-btn-secondary` is `var(--c-surface)`-backed (not transparent) so the float has something to sit on.
- **Do not strip the float or the `:active` rule** from these classes, and **do not set an inline `box-shadow` on an instance** — it overrides the class and breaks the press-in collapse. Size/colour overrides are fine; depth comes from the class.
- **Excluded by design**: nav text links (`.m-btn-link`, "Learn more →" etc.) and the header utility pill below stay **flat** — depth on navigation reads as a CTA, which violates the navigation-button rule.

### Standard pill button (header row)

```html
<button style="height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--c-border);
               background:transparent;font-size:11px;font-weight:600;color:var(--c-muted);
               cursor:pointer;letter-spacing:0.02em">Label</button>
```

### Glass button — `.m-btn-glass` (default for taps)

The canonical interactive button for anything the user taps to perform an action: onboarding CTAs, home actions (Coach, Check-in, Adjust plan), modal confirms, wizard next steps, settings rows. Uses frosted white, Apple three-layer shadow stack, firm press-in feedback.

```html
<button class="m-btn-glass">Label</button>
<button class="m-btn-glass" style="width:100%">Full-width variant</button>
<button class="m-btn-glass m-btn-glass--inset">Inside a card</button>
<button class="m-btn-glass m-btn-glass--icon" style="width:36px;height:36px">AB</button>
```

**Two shadow levels:**
- **Default (`.m-btn-glass`)** — full three-layer float. Use on backgrounds: sky gradient home header, modals over a dim, onboarding screens, page-level CTAs.
- **Inset (`.m-btn-glass m-btn-glass--inset`)** — calmer two-layer shadow. Use when the button lives **inside an already-elevated surface** (a card, a modal body). The card owns the lift; the button should not compete with it.

Rule of thumb: if the button is nested inside anything with its own `box-shadow`, add `--inset`.

**Use it for:**
- Every onboarding / wizard button
- Home header actions and in-card CTAs
- Any button meant to feel tactile

**Do not use it for:**
- Navigation text links ("Learn more →", "Breakdown →") — those stay muted text, no border
- Destructive confirms (Delete, Discard) — keep those plain bordered to avoid making danger feel playful
- Tight data rows where a pill would overpower the surrounding text

**Behaviour**: press state scales to 0.985 with a soft inset shadow. Transition is 120ms so it feels responsive, not laggy. Source of truth is `src/styles.css` — never re-implement inline.

---

## Daily Insight Card (Coaching Narrative)

Used on: Home tab (daily headline), Recovery detail screen.
Reference: Bevel's recovery insight card pattern (see `docs/BEVEL.md`).

### Purpose

A single card that synthesises multiple signals (HRV, sleep, load, planned workout) into
2–3 plain-English sentences. Rules-based, not LLM. The goal is one clear statement of
what the data means for today's training.

### Anatomy

```
┌──────────────────────────────────────────────────────────┐
│ HRV 12% below 7-day baseline                         ↗   │  ← headline (bold, 13px)
│ Padel session yesterday added 45 TSS. Threshold run       │
│ today carries higher injury risk — consider moving         │
│ it to Thursday.                                           │
└──────────────────────────────────────────────────────────┘
```

- **Outer container**: `rounded-xl`, `bg-neutral-50` (light) or `bg-slate-800/60` (dark).
  No heavy shadow — subtle `border border-neutral-200`.
- **Headline**: 13px, `font-weight:600`, left-aligned. No emoji.
- **Body**: 13px, `line-height:1.5`, `var(--c-muted)`. Inline bold for key numbers
  (e.g. `<strong>45 TSS</strong>`).
- **Expand arrow**: `↗` top-right corner, `var(--c-faint)`. Tapping opens the Recovery
  detail page or a full-screen insight breakdown.

### Rules

- Max 2 sentences in the body. One fact, one implication.
- Never start with "You" — state the data, then the implication.
- No emoji anywhere in this card.
- Key numbers inline-bolded. Units always present (ms, TSS, bpm, hours).
- If no meaningful signal today (all green, no spikes): show nothing — do not display
  a generic "all looks good" card. Silence is better than noise.

### Signal priority (which to surface)

1. Recovery debt (orange/red) — always trumps everything else
2. HRV trend (7-day declining > 10%) — high-value signal
3. Sleep debt (cumulative deficit this week)
4. Load spike (yesterday's session was >150% of daily baseline)
5. Neutral — omit card

---

## Recovery Metric Tiles (HRV + RHR)

Used on: Recovery detail screen, potentially Home readiness area.
Reference: Bevel recovery screen dual-tile layout.

### Pattern

Two equal-width tiles side by side. Each tile shows:
- Label row: metric name in 11px `var(--c-muted)`
- Value: 22–24px, `font-weight:300`, left-aligned
- Trend indicator: `▲` (green) or `▼` (red) or `→` (neutral) immediately after value,
  10px, compared to 7-day average

```html
<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
  <div class="m-card" style="padding:12px 14px">
    <div style="font-size:11px;color:var(--c-muted)">Resting HRV</div>
    <div style="font-size:22px;font-weight:300">
      65.1<span style="font-size:13px;margin-left:2px">ms</span>
      <span style="font-size:11px;color:#34C759">▲</span>
    </div>
  </div>
  <!-- RHR tile same structure -->
</div>
```

### Trend calculation

- `▲` green: today's value > (7-day avg × 1.05) for HRV; < (7-day avg × 0.95) for RHR
- `▼` red: today's value < (7-day avg × 0.95) for HRV; > (7-day avg × 1.05) for RHR
- `→` neutral: within 5% of 7-day average
- If fewer than 3 days of data: omit trend indicator entirely

---

## Sleep Stage Breakdown Rows

Used on: Sleep detail page (future build).
Reference: Bevel sleep screen side panel — "Primary Sleep" card.

### Pattern

Vertical list of labeled rows. Each row:
- Label left (e.g. "REM sleep"), 13px
- Quality label right (Good / Excellent / Poor / —), 12px, colour-coded
- Full-width bar beneath, `height:4px`, rounded, showing stage duration as % of optimal

```
Time asleep         Good     ██████████████████░░
REM sleep           Excellent ████████████████████
Deep sleep          Excellent ████████████████████
Heart rate dip      Poor     ████████░░░░░░░░░░░░
```

**Quality colours**:
- Excellent: `#34C759` (green)
- Good: `#3B82F6` (blue)
- Poor: `#FF9500` (amber) — not red; poor sleep isn't dangerous, just suboptimal
- No data: `—` in `var(--c-faint)`, no bar

**Bar colour**: same as quality colour (fill), `var(--c-border)` for the unfilled track.
Bar represents actual vs target for each stage (e.g. REM target = 25% of sleep duration).

---

## Population Distribution Charts (PDF from real breakpoints)

Used in: `src/ui/hyrox/percentile-distributions.ts` ("Where you sit" card on the HYROX forecast).

### Purpose

Show the user where their result sits inside the population — a single asymmetric bell (or right-skewed shape) per metric, with the user's line on it.

### Rule: never synthesise a curve when real data exists

If the codebase has cumulative-percentile breakpoints for the metric (e.g. `[[3829, 1], [4163, 5], …, [8856, 99]]` = 1% of finishers at-or-below 3829s, etc.), the curve must be **derived from those points**:

1. **Differentiate**: per-segment density = `(p_{i+1} − p_i) / (t_{i+1} − t_i)`, anchored at the segment midpoint.
2. **Pad the tails** with zero-density anchors slightly outside the data range so the bell fades to zero at the edges.
3. **Oversample** with linear interpolation to ~80 samples across the visible range.
4. **3-point box smooth** for visual cleanliness (no Bézier, no spline — area-chart pattern is sharp lines).
5. **Plot** as a polyline + filled area underneath.

If no real data exists for a subset (e.g. unsupported race format), fall back to a synthesised band-anchored Gaussian only when explicitly labelled as "approximate".

### Layout

- **Card**: canonical data-glass (`rgba(255,255,255,0.78) + blur(16px) + soft shadow + no border`).
- **Subtitle leads with provenance, from one caption helper.** HYROX surfaces that place a time against the results data (the distributions card, the Stats rank card, the radar, the onboarding review) call `hyroxResultsCaption(cohort)` (`src/calculations/hyrox-results.ts:345`) or `hyroxPlacementCaption` for an age group. It names the seasons with years, the cohort's finisher count (read from the data module, never typed into UI code) and the source: "HYROX results, seasons 8 and 9 (2025 to 2026), 119,468 Open Singles women finishers, via the open pyrox project." The cohort is the athlete's own: singles by sex, doubles by the pair's division, pooled only when neither is known. Every format has real tables, so no HYROX surface uses the synthetic fallback. A guard test (`hyrox-population-captions.test.ts`) fails on a hardcoded count anywhere in `src` outside the data files. Retired: "Live HYROX field. 89,868 finishers across S4–S6" (untrue "live", a hardcoded all-format total) and lane H1's pooled-sex S4 to S6 caption with its 75-rep era note.
- **Say what comes from the data and what does not.** The results set the finish and station percentiles, the band seed times and the doubles and Pro conversions; station times come from the athlete's benchmarks where tested and run legs from running fitness. `hyroxForecastProvenanceCaption` and `hyroxMethodologyCaption` say which.
- **Per-row layout**: label (left) + user time + tier label (right, e.g. "top 1%", "median", "bottom 25%") on top; chart underneath. The total row names its cohort ("top 14% of women", see Tier label translation).
- **Chart height**: 64px viewBox.
- **One data colour**: `STROKE = #64748B` slate-500 line at 1.5px, `FILL = rgba(100,116,139,0.12)` underneath, `USER_LINE = #0F172A` slate-900 for the marker. Plus `rgba(0,0,0,0.10)` dashed for p25/p50/p75 guides. No chromatic accents.
- **Reference markers** (p25 / p50 / p75): vertical dashed SVG lines, with HTML `<span>` labels positioned via `left:%` in a 14px row underneath the chart. Never SVG `<text>` (would distort with `preserveAspectRatio="none"`).
- **User marker**: vertical solid line + small HTML overlay dot at the top, plus a small "you" label in the under-chart label row. Edge-aware horizontal anchoring (left, right, or centred) so the label never bleeds off the chart.
- **Off-chart users**: when the user's time falls outside the visible range, pin at edge and show a small `◂` or `▸` indicator instead of clipping the line.

### SVG sizing rules (compulsory)

- `preserveAspectRatio="none"` + explicit `height:Npx` + `width:100%`.
- `vector-effect="non-scaling-stroke"` on every `<line>` and `<path>` stroke so widths render true regardless of horizontal stretch.
- **No `<circle>` and no `<text>` inside the SVG** — both distort under non-uniform scaling. Move them to HTML overlays positioned via `left:%`.

### Tier label translation

Display the friendly tier instead of "p99" jargon: `top 1% / top 5% / top 10% / top N% (50<f<90) / median / bottom N% / bottom 5%`. The percentile number stays in the audit log internally but the user sees plain words.

Every HYROX percentile chip reads the tier (`hyroxTierLabel`, `hyrox-population.ts:126`): the forecast station rows, the biggest-targets rows, the station detail hero and the distributions card. No chip shows "pNN", because the distributions card's p25/p50/p75 guides are cumulative time percentiles and "p73" would mean the opposite there.

**Name the cohort where the percentile can be read against another surface's** (lane H3c, 2026-10-13). The "Where you sit" total row reads `hyroxTierLabelIn(f, cohort)` (`src/calculations/hyrox-population.ts:146`): "top 14% of women", "bottom 30% of mixed pairs", "median among men's pairs" (the noun from `hyroxCohortNoun`). The Stats rank line places the same finish in an age group, and an unnamed "top 14%" next to it read as a disagreement. Station, run and Roxzone rows keep the short label. The row header uses `gap:8px`, a non-shrinking label and a right-aligned value so the longer label wraps without overlapping.

### Rank lines and history frames (HYROX)

- **Rank lines** read "Faster than X% of <cohort>" (`hyroxPlacementWho`: "women aged 30 to 34", "Open Singles men", "mixed pairs aged 30 to 39"). Past a table's slow end, or below 5%, write "Slower than X% of ...". Past a coarse table's end the badge shows the bound ("<25%"), never a point value, and the bar draws the bound as a range (lane H3c).
- **History views that mix sources** (race splits and tests, the pair's times and solo times, Pro and Open weights) convert every entry to one frame per card with the forecast's own conversion and label it once, on the first card in that frame, never per row. Rows that show forecast lines keep PRs and deltas in the line's frame (the pair's time for doubles); solo-history cards show one athlete at the race's weights. Write "your race's weights", not a division name: a woman in Mixed Doubles trains at M-Open, the Women Pro tier.

---

## Radar / Spider Charts (HTML labels, gutter zones)

Used in: `src/ui/hyrox/performance-radar.ts` (HYROX 8-axis station percentile).

### Rule: SVG holds geometry, HTML holds labels

Long axis labels ("Sandbag Lunges", "Burpee Broad Jumps") clip at the SVG viewBox edge in narrow containers when written as `<text>`. Always render labels as HTML `<span>` elements absolutely-positioned over a `position:relative` square wrapper. The SVG sits inset from each side, leaving gutters for labels.

### Layout

- **Wrapper**: `position:relative; aspect-ratio:1/1; max-width:380px; margin:0 auto`.
- **SVG inset**: ~19% per side. SVG viewBox `0 0 200 200`, polygon outer radius `200 × 0.42`.
- **Labels** snap to one of nine zones based on axis angle:
  - Pure top / bottom (`|cos(θ)| < 0.20`): `left:50%`, `text-align:center`, `max-width:54%`, anchored to top/bottom edge.
  - Pure left / right (`|sin(θ)| < 0.20`): pinned to wrapper edge with `text-align:right` (right side) or `left` (left side), `max-width:20%`.
  - Corners: pinned to top/bottom corners (`top:13%` or `top:87%`), anchored to outer wrapper edge, `max-width:28%`.
- **Why zone snapping not polar maths**: at any container width, labels sit fully inside the wrapper and never overlap the polygon. They wrap to two lines naturally when text is long.

### Polygon polish

- **Fill**: radial-gradient from `rgba(slate-600, 0.18)` at centre to `rgba(slate-600, 0.04)` at the edge — gives lift without violating the no-decorative-gradient rule (this is data-carrying, marks where the user's polygon is).
- **Stroke**: linear-gradient `slate-900 → slate-600` (corner to corner). 1.6px, `stroke-linejoin:round`.
- **Dashed when uncalibrated**: any seed-only station turns the whole polygon stroke into `stroke-dasharray="4 3"` to communicate provisional status.
- **Dots**: calibrated stations get a filled `slate-900` dot with a `rgba(255,255,255,0.95)` halo behind it (premium "lifted off the page" feel). Seed-only stations get a hollow open circle (white fill, slate-900 stroke).

### Subtitle

Same rule as distributions: lead with provenance, and state what the axis really is. Each spoke places the forecast line's station time among the cohort's race splits at that station (`getStationPercentile` on `hyroxCohortForState`; the pair's time on the pair's division for doubles). The subtitle reads, for an Open Singles woman, "HYROX results, seasons 8 and 9 (2025 to 2026), 118,063 Open Singles women finishers, via the open pyrox project. Each spoke places your station time among the field's race splits. Further out is faster." (`performance-radar.ts:185`). Retired: "Each spoke shows where you sit on that station vs S4–S6 field. Outer ring is top 1%." (the outer ring is 100) and lane H1's "these are estimates" subtitle, written when the data had no per-station splits.

---

## Visual Constraints

These apply to every component, chart, and card in the app. Check all four before writing any UI code.

### Colour budget: max 2 non-neutral colours per component

A "non-neutral colour" is anything that isn't black, white, or a grey/alpha variant. Status colours (green, amber, red) and the blue accent count.

- **One data colour per chart** — no categorical colouring by phase, activity type, week type, etc.
- If you need to distinguish two data series, use solid vs dashed on the same hue.
- Phase/category differences are communicated with **text labels**, never colour.
- **No rainbow legends** — if you need a legend, the chart is already wrong.

**Anti-patterns:**
- Bars coloured orange/purple/yellow/blue by training phase → use a single blue with a text label
- Zone bars with 4+ distinct hues → permitted only in the fitness position bar (it IS the data)
- Tinted card backgrounds to indicate category → always neutral surface

### SVG text is banned in stretched charts

**Never use `<text>` elements inside an SVG with `preserveAspectRatio="none"`.**
The viewBox is 320px wide but the SVG renders at full container width — all SVG text scales up proportionally and appears enormous.

Use absolutely-positioned HTML `<span>` elements instead, positioned via `left: ${(xSvg / viewBoxW * 100).toFixed(1)}%` inside a `position:relative` wrapper over the SVG. This is how y-axis labels, phase labels, and all other chart annotations work.

### No decorative elements

- No emoji in body copy, buttons, or header actions (permitted only in workout-type badges)
- No ALL-CAPS data labels or section headers inside cards
- No tinted card backgrounds (every card is `var(--c-surface)`)
- No decorative gradients on backgrounds or cards

---

## General Principles

- **Fit, don't fill**: Charts should take the space the data warrants. If a metric barely changes, don't give it a full-height chart — consider a pill or stat row instead.
- **Colour carries meaning**: Red = bad/low, amber = caution/developing, green = good/high. Don't invert this.
- **Labels serve the active state**: In any multi-zone element, highlight only where the user currently is. Everything else is context, not content.
- **No training paces section**: Removed — paces are surfaced contextually in the plan view, not as a stats table.

---

## Design System (Global)

These tokens apply across all pages and are defined in `src/styles.css`.

### Colour palette

| Token | Value | Use |
|-------|-------|-----|
| `--c-bg` | `#FAF9F6` | Page background (warm off-white) |
| `--c-surface` | `#FFFFFF` | Card background |
| `--c-black` | `#1A1A1A` | Primary text |
| `--c-muted` | `#555555` | Secondary text |
| `--c-faint` | `rgba(0,0,0,0.52)` | Tertiary/caption text |
| `--c-border` | `rgba(0,0,0,0.09)` | Subtle dividers (not card borders) |
| `--r-card` | `16px` | Card corner radius |

### Card style (`.m-card`)

Cards use **soft shadow, no border**:
```css
background: var(--c-surface);
border: none;
border-radius: 16px;
box-shadow: 0 2px 4px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.06);
```

When building inline card styles in view files, use this constant pattern:
```ts
const CARD = `background:#fff;border-radius:16px;box-shadow:0 2px 4px rgba(0,0,0,0.06),0 8px 24px rgba(0,0,0,0.06)`;
```

### Card entrance animations

Cards should feel alive when pages load. Use staggered fade-in with subtle scale:

```css
@keyframes floatUp {
  from { opacity:0; transform:translateY(16px) scale(0.97); }
  to   { opacity:1; transform:translateY(0) scale(1); }
}
.fade { opacity:0; animation:floatUp 0.6s cubic-bezier(0.2,0.8,0.2,1) forwards; }
```

Stagger with `animation-delay` increments of ~0.06s per card. The ring/hero section starts at 0.08s, first card at 0.14s.

### Page container

All detail pages use `max-width:480px;margin:0 auto` on the content wrapper to prevent charts from stretching on wide screens.

### Tab bar on every page

**Every page must include the tab bar**, including detail/drill-down pages. The tab bar highlights the parent tab (e.g. "Home" for strain-view, readiness-view, etc.).

```ts
import { renderTabBar, wireTabBarHandlers, type TabId } from './tab-bar';

// In HTML: ${renderTabBar('home')}
// In wiring: wireTabBarHandlers(navigateTab);
```

Detail pages wire a `navigateTab` function with dynamic imports to avoid circular dependencies.

### Text tokens (for inline styles in view files)

| Token | Value | Use |
|-------|-------|-----|
| `TEXT_M` | `#0F172A` | Primary text (headings, numbers) — slate-900 |
| `TEXT_S` | `#64748B` | Secondary text (labels, descriptions) — slate-500 |
| `TEXT_L` | `#94A3B8` | Tertiary text (axis labels, captions) — slate-400 |

**Do not use** `#111`, `#555`, `#999`, `#2C3131`, `#6B7280`, or `#9CA3AF` — these are legacy values that appear in older views. Use the tokens above.

### Typography scale

All detail pages share a single type hierarchy. Reference: `recovery-view.ts` (Physiology page).

| Role | Size | Weight | Colour | Use |
|------|------|--------|--------|-----|
| **Page title** | 20px | 700 | `TEXT_M` | Centred title in hero ("Physiology", "Sleep", "Strain") |
| **Hero metric** | 48px | 700 | `TEXT_M` or semantic | The single big number in the ring (score %, TSS) |
| **Hero unit** | 22px | 700 | `TEXT_M` | Unit/suffix after hero metric ("%" , "/100") |
| **Hero subtitle** | 14px | 500 | `TEXT_S` | Label below hero metric ("recovered", "sleep score") |
| **Section heading** | 17px | 700 | `TEXT_M` | Card group headings ("Detailed Metrics", "Timeline") |
| **Card metric title** | 15px | 600 | `TEXT_S` | Title row inside a metric card ("Resting HRV", "Resting HR") |
| **Card large value** | 24px | 700 | `TEXT_M` | Main value inside a card (HRV ms, RHR bpm) |
| **Card unit** | 13px | 500 | `TEXT_S` | Unit after card value ("ms", "bpm") |
| **Body text** | 14px | 500 | `TEXT_M` at 0.9 opacity | Coaching paragraphs, explanations |
| **Label** | 13px | 600 | `TEXT_S` | Status badges, tab labels, inline descriptions |
| **Caption** | 11px | 500–600 | `TEXT_L` | Axis labels, timestamps, sub-labels below rings |
| **Micro** | 9–10px | 500–600 | `TEXT_L` | Y-axis labels, day-of-week labels on charts |

### Ring sizes

| Ring | Radius | Circumference | Use |
|------|--------|---------------|-----|
| **Hero ring** | 46 | ≈ 289.03 | Main ring at top of every detail page |
| **Mini ring** | 20 | ≈ 125.66 | Sub-metric indicators (e.g. HRV/Sleep/Load sub-scores) |

**Do not use** `RING_R = 57` — this is a legacy value. All hero rings are radius 46.

### Ring SVG structure (canonical pattern)

All hero rings use a **glass container + 3-stop gradient arc**. This is the single canonical pattern — do not use flat single colors or 2-stop opacity fades on rings. Reference: `readiness-view.ts` (first and definitive implementation).

**Glass outer container** (the 220px div IS the visible circle — no separate inner white disk):
```html
<div style="
  position:relative;width:220px;height:220px;
  display:flex;align-items:center;justify-content:center;
  background:rgba(255,255,255,0.55);backdrop-filter:blur(16px);
  border-radius:50%;border:1px solid rgba(255,255,255,0.6);
  box-shadow:0 6px 40px -8px rgba(0,0,0,0.15);
">
  <svg style="position:absolute;width:100%;height:100%;transform:rotate(-90deg)" viewBox="0 0 100 100">
    <defs>
      <!-- SVG is rotated -90deg; visual upper-left light source = bottom-left in rotated coords -->
      <linearGradient id="unique-ring-grad" x1="20%" y1="90%" x2="80%" y2="10%">
        <stop offset="0%"   stop-color="${stops.highlight}"/>
        <stop offset="50%"  stop-color="${stops.mid}"/>
        <stop offset="100%" stop-color="${stops.shadow}"/>
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="${RING_R}" fill="none" stroke="rgba(0,0,0,0.07)" stroke-width="8"/>
    <circle cx="50" cy="50" r="${RING_R}" fill="none"
      stroke="url(#unique-ring-grad)" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"
      data-target-offset="${targetOffset}"
      style="transition:stroke-dashoffset 1.2s cubic-bezier(0.2,0.8,0.2,1);transform-origin:50% 50%"/>
  </svg>
  <!-- Centre text: position:relative;z-index:1 (no separate background circle) -->
  <div style="position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center">
    <!-- hero number + label -->
  </div>
</div>
```

**3-stop gradient recipe**: derive `highlight` (bright), `mid` (main), `shadow` (dark) from the metric's semantic color. Use `readinessColorStops()` as the reference. Gradient direction `x1="20%" y1="90%" x2="80%" y2="10%"` is fixed — this positions the visual light source at the upper-left of the arc after the -90deg SVG rotation.

**Home page arc rings** (270° sweep, `<path>` based, viewBox `0 0 120 120`): use `gradientUnits="userSpaceOnUse"` with `x1="15" y1="15" x2="105" y2="105"`. This maps the upper-left highlight to the top-left portion of the arc and shadow to the lower-right end.

**Do not**:
- Use an opaque inner 180px white disk (removed — the glass outer container replaces it)
- Use only 2 gradient stops (opacity 0→1 or just light→dark without a mid stop)
- Use a glow filter (`feGaussianBlur`) on the ring circle — it blurs the crisp arc edge
- Use flat single `stroke` colors on any ring

**Fixed values**: container 220×220, viewBox `0 0 100 100`, center `50,50`, stroke-width `8`, `RING_R = 46`, `RING_C ≈ 289.03`. Do not use other viewBox sizes (130×130, 160×160) or other centers (65,65 or 80,80) — these are legacy.

### Hero numbers

Large data values displayed at the top of a detail page:
- Font size: 48px
- Font weight: 700
- Letter spacing: -0.03em
- Colour: semantic (warm terracotta `#C4553A` for "high", `TEXT_M` for normal, `TEXT_S` for low)
- Unit suffix: 22px, `TEXT_M`, font-weight 700, inline after the number

### Status pills

Inline pills next to hero numbers showing status:
```html
<span style="font-size:11px;font-weight:600;color:${pillColor};background:${pillBg};
             padding:3px 10px;border-radius:100px">${label}</span>
```

### Spacing standards

| Element | Value | Notes |
|---------|-------|-------|
| **Card padding** | 16px | All sides, consistent |
| **Card gap (between cards)** | 16px | `gap:16px` or `margin-bottom:16px` |
| **Hero section padding** | 20px horizontal | Content within hero area |
| **Section heading margin** | `0 0 16px 2px` | Below heading, slight left indent |
| **Metric card inner gap** | 6–8px | Between label/value/sparkline rows |
| **Page max-width** | 480px | `max-width:480px;margin:0 auto` |
| **Hero background height** | 480px | All pages, no exceptions |

### Section labels

Small uppercase labels above hero numbers or card sections:
```
font-size:10px; font-weight:600; text-transform:uppercase;
letter-spacing:0.08em; color:TEXT_S
```

This is the one permitted use of uppercase in cards — for section labels only, not data values.

---

## Charts

### Line charts (time-series)

- **Sharp angular lines** (polyline, `stroke-linejoin:"round"`). No bezier smoothing.
- **Stroke**: `#64748B` (muted slate), width 1.5px
- **Grid lines**: `rgba(0,0,0,0.05)`, width 0.5px
- **Average/reference dashed line**: `rgba(0,0,0,0.12)`, width 1px, `stroke-dasharray="4 3"`. **Must have an HTML label** (e.g. "avg") positioned in the y-axis gutter (right side). Labels must **never overlap data** — place them outside the chart area. No unlabelled dashed lines.
- **Y-axis labels**: HTML `<span>` elements positioned in a 36px right gutter (never SVG `<text>`, which distorts when stretched). Font: 9px, `TEXT_L`, `tabular-nums`.
- **X-axis labels**: HTML `<span>` elements with `position:absolute`, percentage-based `left`. Font: 9px, `TEXT_L`.
- **No `preserveAspectRatio="none"`**: charts scale proportionally with `width="100%"` and no fixed height.

### Stacked bar charts (zone breakdown)

- Each bar shows its **total TSS** label above the bar (8px, font-weight 600, `TEXT_S`)
- Each zone segment shows its **individual TSS** centered inside (7px, font-weight 600, `rgba(255,255,255,0.85)`) — only when the segment height >= 14px
- Bar corner radius: 4px
- Day labels below: 9px, `TEXT_L`
- Legend: dot (8px circle) + label (11px, `TEXT_S`), flex row above bars

### Zone colours (data-carrying, permitted exception to 2-colour budget)

| Zone | Colour |
|------|--------|
| Anaerobic | `#D06B98` (rose) |
| High Aerobic | `#E8924C` (warm amber) |
| Low Aerobic | `#67C9D0` (teal) |

These three are permitted together in zone charts because they ARE the data.

### Triathlon discipline / benchmark colours (canonical — do not change without explicit ask)

Used on the triathlon Stats page: trend sparklines, CTL chart, TSS chart, volume charts, and legend chips. All four are cool tones; area fill opacity is 0.08.

| Metric / Discipline | Stroke | Fill |
|---|---|---|
| VO2max | `#34C759` green | `rgba(52,199,89,0.08)` |
| Swim / CSS | `#38BDF8` sky | `rgba(56,189,248,0.08)` |
| Bike / FTP | `#8B5CF6` violet | `rgba(139,92,246,0.08)` |
| Run / LT | `#14B8A6` teal | `rgba(20,184,166,0.08)` |

The line colour is fixed per metric/discipline for visual identity. The delta change label turns `#34C759` (green) when improving and `#FF3B30` (red) when declining — independently of the line colour.

Implemented in `src/ui/triathlon/benchmark-charts.ts` (sparklines) and `src/ui/triathlon/progress-detail-view.ts` (`DISC_CHART` constant).

---

## Ring Backgrounds + Sun Glint (the "page-flair" system)

The default visual system for new UI work. Lives in `src/ui/page-flair.ts`. Three layered building blocks designed to be composed per page:

### The four building blocks

| Block | Function | Purpose |
|-------|----------|---------|
| Atmosphere | `buildAtmosphereBase(palette?)` | Soft cool radial gradient base. Replaces flat `var(--c-bg)` warm cream so other layers have somewhere to live. |
| Rings | `buildRingBackground(prefix, opts)` | Concentric SVG circles with light-source gradient strokes. Five composition variants. Optional pulse + entrance animation. |
| Sun glint | `buildSunGlint(intensity)` | Warm cream radial-gradient at upper-left of every page. The universal brand mark. |
| Glassy card | inline CSS recipe | `rgba(255,255,255,0.58) + backdrop-filter:blur(24px)` (locked spec for onboarding). Quieter data variant: `0.78 + blur(16px)`. |

### Layering order

`atmosphere → rings → sun glint → content` (z-index 1 on content). Background layers sit absolutely positioned inside a `position:relative; overflow:hidden` outer container.

### Ring variants

| Variant | Composition | Use for |
|---------|-------------|---------|
| `centered` | 5 rings + 2 off-axis ellipses, centred. Optional pulse. | Hero / arrival moments (intro slides, plan-preview-v2, week debrief) |
| `sweep` | 4 large rings centred off-canvas below — only top arcs visible | Goals — "rising from below" feel |
| `focused` | 3 small rings tight in upper area | Review — "you're nearly there" energy |
| `asymmetric` | 3 rings offset to one side (`side: 'left' \| 'right'`) | Connect-Strava (right), Schedule (left), Triathlon-setup, Manual-entry |
| `whisper` | 2 huge faint arcs only | Welcome name page, Initialising screen — barely-there family signature |

### Ring options

- `palette: 'blue' | 'teal'` — default `'blue'`. Teal used for race-prediction surfaces and any "green" moment.
- `entrance: 'large' | 'small' | 'none'` — default `'small'`. Use `'large'` only for the first-ever ring appearance per device (gate via `isFirstRingExperience()`).
- `pulse: boolean` — opt-in. Pulses the near-ring group only (motion parallax sells depth). Finite cycles (`pulseCycles`, default 6 ≈ 54s).

### Depth recipe (why rings feel layered, not flat)

Three gradient tiers (outer / mid / inner) with progressive opacity envelopes — the same DNA, different intensities so inner rings pop and outer rings recede. Depth reads entirely from the **gradient stroke + the opacity tiers** (far ≈ 0.12 → near = 1.0).

**No SVG filters on the rings.** Earlier versions blurred the far rings (`feGaussianBlur`) and drop-shadowed the near rings. Both were removed (2026-05-27): every ring animates its transform (entrance bloom, drift, pulse, halo breathe), and a transform animating *through* a filter forces the browser to re-rasterize the filtered region every frame — measured at ~30fps with multi-100ms stalls (the "skip" / "stutter" on Stats & Readiness). Crisp rings hold a solid 61fps with zero dropped frames and are visually indistinguishable at rest (the far-blur was imperceptible; the near drop-shadow was a subtle lift). The same applies to CSS `filter: blur()` (even worse — re-rasterizes on every scale step) and to the flowey wave/halo layers. Never re-add a filter to anything that animates its transform.

### Sun glint intensities

| Intensity | Use for |
|-----------|---------|
| `low` | Home, Plan, Stats, Account, all detail pages (alongside mountain backgrounds) |
| `mid` | Wizard steps (alongside ring backgrounds) |
| `high` | Hero / celebration moments only |

### Animation system

- **First-ever ring** (per device, gated by `isFirstRingExperience()`): large water-droplet entrance (~1.4s, scale 0.28→1, 200ms stagger inner→outer) plus a single light Capacitor haptic. Mark seen via `markRingExperienceSeen()`.
- **All subsequent**: small "settle" entrance (~0.55s, scale 0.85→1, 80ms stagger). Designed to be near-invisible on rapid form toggles.
- **Pulse**: opt-in, finite cycles, freezes at opacity 1.
- **Wave pulse**: trigger via `triggerRingWave(prefix)` for persistent-ring contexts (slide transitions). Subtle scale flicker propagates inner→outer like dipping a finger in water.

### Exclusivity rule (do NOT mix backgrounds)

- **Rings**: wizard / hero / arrival contexts. Never on data-heavy pages where they'd compete with charts/cards.
- **Mountains** (`buildSkyBackground` from `sky-background.ts`): detail pages only (recovery, readiness, sleep, etc.).
- **Sun glint**: universal — every page in the app.

Do NOT paint rings behind a mountain page or vice versa.

### Rendering performance (web *and* iOS)

Mosaic ships to both web (desktop + mobile browsers) and iOS (Capacitor / WKWebView). The first two rules below were diagnosed on **desktop browser**, not just on device — do not file them as iOS-only and dismiss them when web-testing. WKWebView amplifies the same costs (often worse), but the underlying mechanism is identical across engines.

- **`feGaussianBlur` / CSS `filter` + transform animation on the same element is a perf cliff (every engine).** The filtered region re-rasterizes every frame (~30fps, multi-100ms stalls — measured 2026-05-27). Ring/halo/wave backgrounds are filter-free for this reason (see Depth recipe above). The page-flair pulse is opacity-only. Never combine any filter with a transform animation.
- **`backdrop-filter` glass must not sit over *animating* content (every engine).** The backdrop re-samples whatever moves behind it every frame, and the glass element + all its children flicker (real bug 2026-05-27 on desktop Chrome: the Readiness hero score ring + the "53" flickered because the halo breathed behind its `backdrop-filter:blur` disc; made worse once the rings were crisp). Fix: keep the background **static** wherever glass overlays it. The Readiness halo is intentionally static for this reason; do not re-add `floweyHaloAnimationCSS` there. If you need motion behind glass, either drop the `backdrop-filter` on that element (use a higher-opacity solid backing) or ensure the animation settles before the glass renders.
- **`backdrop-filter: blur(24px)` stacking** — heavy on older iPhones *and* low-end browsers; use the quieter `blur(16px)` for nested-glass surfaces. Stacking many glassy cards on the same page is a perf risk on both engines.
- **Card entrance animations are opacity-only — never transform.** A glass card animating `translateY`/`scale` moves its backdrop-sample region every frame, forcing a per-frame re-blur (the same cliff as glass-over-motion, self-inflicted). Real bug 2026-06-05 on device (TestFlight): every tab view floated its glass cards up over an animating ring background — Forecast cards "jumped" at ~30fps. All `*FloatUp` keyframes are now `from { opacity:0 } to { opacity:1 }` (32 sites swept). Do not re-add a transform to an entrance keyframe; if a new surface needs motion, it must not carry `backdrop-filter`.
- **Tab-level entrances play once per session — `shouldPlayEntrance(key)`.** Every tab switch is a full re-render, so entrance animations used to replay on every visit (~0.9s of stagger per switch + ring entrance + 6.5s drift behind glass). Tab views (Home, Plan, Forecast, Stats — all modes) now gate on `shouldPlayEntrance('<view-key>')` from `page-flair.ts`: first visit per session animates; revisits emit settled CSS (`opacity:1`, no animation) and pass `entrance:'none', pulse:false` to `buildRingBackground`. A new tab-level view must follow this pattern; drill-down/detail pages and the onboarding wizard intentionally keep their per-open entrances (opacity-only, cheap).
- **iOS-specific**: sun glint sits at viewport `top:0,left:0` — on notched iPhones use `top: max(20px, env(safe-area-inset-top, 20px))` on top-positioned chrome (skip buttons, headers) so it doesn't clash with the notch area. Haptics fire only on the very first ring entrance (gated by localStorage), never on every navigation, and silently no-op on web.

### When to use vs when not

**Use when**: building a wizard step, an onboarding moment, a hero arrival page, an info screen with light content (Account-style).

**Don't use rings when**: the page is data-heavy (cards, charts, calendars, lists) — they'll compete. Use sun glint alone in those contexts.

**Don't invent new backgrounds**: extend `page-flair.ts` instead. Adding a new variant or palette there means future surfaces inherit the family DNA.

---

## Page Backgrounds (legacy mountain scenes — detail pages only)

Each detail page has a unique SVG nature scene in warm tones. The background is a `position:absolute` div at `z-index:0` behind the content, with a bottom fade to `PAGE_BG`.

### Rules

- Background height: 340-480px depending on page content
- Bottom fade: `linear-gradient(to top, PAGE_BG, transparent)` over the last 80-100px
- SVG uses `preserveAspectRatio="xMidYMid slice"` to cover the full width
- Clouds/shapes use `feGaussianBlur` filters for softness
- Opacity range: 0.15-0.55 (visible but not competing with content)
- All gradient/filter IDs must be prefixed with a page-specific prefix (e.g. `rl` for rolling load, `rdn` for readiness) to avoid DOM conflicts

### Per-page themes

All detail pages use `buildSkyBackground(prefix, palette)` from `src/ui/sky-background.ts`. Each page gets a unique colour palette but identical wave/mountain structure with subtle CSS drift animation.

| Page | Palette | Sky gradient top | Key tones |
|------|---------|-----------------|-----------|
| Physiology (Recovery) | `blue` | `#C5DFF8` | Soft blue mountains, white mist |
| Readiness | `blue` | `#C5DFF8` | Same as Physiology |
| Freshness | `blue` | `#C5DFF8` | Same as Physiology |
| Sleep | `indigo` | `#C5C8F8` | Indigo/lavender mountains |
| Strain | `teal` | `#C5EFF8` | Teal/cyan mountains |
| Rolling Load | `deepBlue` | `#A8C8F0` | Deeper blue, navy-tinted peaks |
| Load/Taper | `slate` | `#C8D0E0` | Cool grey-blue, slate mountains |
| Injury Risk | `grey` | `#D0D4DC` | Neutral grey mountains |
| Home | Light sky | `#C5DFF8` → `#FAF9F6` full-page | Cloud shapes, landscape paths |
| Plan | Light sky (phase-tinted) | Phase-keyed gradient, same structure as Home | Cloud shapes, landscape paths |
| Stats | None | Flat `--c-bg` | No background scene (tab page) |

### Reference implementation

See `src/ui/sky-background.ts` for the canonical pattern: `buildSkyBackground(prefix, palette)` generates SVG with defs (gradients + turbulence filters), layered mountain paths, clouds, mist, and bottom fade. `skyAnimationCSS(prefix)` generates 3 drift keyframes for parallax wave movement (12s, 15s, 18s).

---

## Mosaic Visual System (the "page-flair" world)

**Default for all new UI work**: build with the page-flair visual system unless there's a specific reason not to. The system has four building blocks, all in `src/ui/page-flair.ts`:

1. **`buildAtmosphereBase(palette?)`** — soft cool radial gradient base layer. Replaces flat `var(--c-bg)` warm-cream so other layers have somewhere to live. Palettes: `'blue'` (default) or `'teal'` (race-prediction / "green moments").
2. **`buildRingBackground(prefix, opts)`** — concentric SVG rings with light-source gradient strokes (white upper-left → mid → dark lower-right) plus depth via SVG filters (atmospheric blur on far rings, drop shadow on near rings). Five variants: `centered` / `sweep` / `focused` / `asymmetric` / `whisper`. Optional `pulse` (finite cycles, default 6 then settles). Optional `palette: 'blue' | 'teal'`. Optional `entrance: 'large' | 'small' | 'none'`.
3. **`buildSunGlint(intensity)`** — warm cream radial-gradient at upper-left of every page. **The universal brand mark** — appears on every page in the app regardless of other treatments. Intensities: `low` (data pages, detail pages) / `mid` (wizard) / `high` (hero only).
4. **Glassy cards** — `rgba(255,255,255,0.58) + backdrop-filter:blur(24px)` is the canonical onboarding spec (locked, see memory). Quieter data variant: `rgba(255,255,255,0.78) + blur(16px)` for cards inside data-heavy contexts.

**Page wrapper rule — status-bar bleed (2026-06-05)**: every full-page wrapper must carry `.mosaic-page` or `.safe-top-bleed` (styles.css). Body pads for the notch (`padding-top: env(safe-area-inset-top)`), so a bare wrapper's atmosphere gradient starts *below* the status bar and the notch strip shows the cream body colour — a visible seam on device. The class pulls the wrapper's background up behind the status bar (negative top margin + matching padding); the content box stays put and web is unaffected.

**Animation system**:
- First-ever ring appearance per device (gated by `isFirstRingExperience()`): large water-droplet entrance + a single light Capacitor haptic. Then `markRingExperienceSeen()`.
- All subsequent appearances: small "settle" entrance (~0.55s, scale 0.85→1) — designed to be near-invisible on rapid form toggles.
- Pulse: opt-in, finite (default 6 cycles ≈ 54s) then freezes.
- Wave pulse: triggered manually via `triggerRingWave(prefix)` for persistent-ring contexts (slide transitions). Brief opacity+scale flicker propagating inner→outer.

**Layering order** on any page using the system: atmosphere → rings → sun glint → content (z-index 1).

**Exclusivity rule**:
- Rings: wizard / hero / arrival contexts (NOT data-heavy pages)
- Mountains (`buildSkyBackground` from `sky-background.ts`): detail pages only (recovery, readiness, sleep, strain, etc.)
- Sun glint: universal — every page

**iOS performance notes** (Capacitor target):
- **`backdrop-filter: blur(24px)`** is heavy on older iPhones. Stacking multiple glassy cards on the same page is a perf risk. Watch fps when implementing new glassy surfaces. Quieter variant (`blur(16px)`) is preferred for surfaces nested inside other glass.
- **`feGaussianBlur` + animation** on the same SVG element is a perf cliff. The page-flair pulse is opacity-only on a `<g>` containing already-static rings — never combine pulse with filter on the same element.
- **`safe-area-inset-top`**: the sun glint origins at viewport `top:0,left:0`. On notched iPhones it sits behind the notch; ensure no critical content (skip buttons, headers) is positioned where the glint's brightest centre would interfere with readability. Use `top: max(20px, env(safe-area-inset-top, 20px))` on top-positioned chrome.
- **Haptics**: only fire on the very first ring appearance per device (the localStorage-gated large entrance). Never haptic on every navigation — annoying.

When extending this system to a new surface, decide *which combination* of the four building blocks fits, then ship. Don't invent new background patterns ad-hoc — extend `page-flair.ts` so future surfaces share the DNA.

---

## Feature reveals — show users the cool things we built

Mosaic does a lot of work users would never know about — environment normalisation, course factors, durability caps, sleep-debt models, etc. When we ship a non-trivial piece of work that materially changes a number the user sees, **make it discoverable** — but not via a popup unless the popup carries real visual depth.

**Order of preference for surfacing a reveal:**
1. **Capture at onboarding.** If the work introduces a user-facing setting (an environment tag, a default, a toggle), add a row to the relevant wizard step so the user configures it once during setup. New users naturally encounter it; existing users edit from settings. This is the default — most reveals belong here.
2. **Settings entry-point.** Pair the onboarding step with a row on the account/profile page so the user can change the setting later. Use the same chip selector / modal so behaviour is identical in both places.
3. **Inline caption next to the number.** For changes the user can passively read (e.g. "Updated from your rides — beat your last test."), a one-line caption on the existing surface is sufficient. No popup needed.
4. **Reveal popup.** Last resort. Only when the work changes a user-facing number AND has no natural setting AND can't be conveyed via inline caption. If you take this route, the popup must pass the bar below.

**Reveal popup bar** (hard requirements — if you can't meet all four, use one of the options above):
- **Visual depth**: close X in top-right, primary CTA as a filled-black pill ("Save" / "Done" / "Got it"), optional secondary as a transparent "Cancel" link. Single-column content layout (no 2-column orphan grids). 14–16 px border-radius. Glass spec from "Overlays and Modals" section above. Mirror `transitions-overlay.ts`.
- **Hard once-only guard**: gate on BOTH a persisted boolean (`triConfig.notifiedMarkers.<feature>Seen` or equivalent) AND a module-level `shownThisSession` boolean. Set both as soon as the modal is created (not on dismiss) so navigating away can't cause a re-pop. Real incident, 2026-05-11: a popup that only set the flag on dismiss kept reappearing because the overlay attached to `document.body` survived navigation, and saveState races caused multiple triggers.
- **Educational, not promotional**: plain-English summary of what the model does and why it makes the number more honest. No emoji, no "Did you know?", no exclamation marks — consultant tone (see CLAUDE.md "UI Copy" sections).
- **Trigger on the surface where the work matters**: not on app launch. The user must be in the relevant context to find it useful.

**State flag pattern** (when you do build a popup): add a boolean to `triConfig.notifiedMarkers` (e.g. `swimNormalisationSeen`, `durabilityCapSeen`). Optional field (`?:`) per CLAUDE.md's build-target rule.
