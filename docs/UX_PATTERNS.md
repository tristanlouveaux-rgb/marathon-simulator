# Mosaic UX Patterns

Design reference for UI components. Read this before building any new chart, bar, or data visualisation.

**Aesthetic target**: Garmin Connect meets minimal iOS. Athletic, factual, no AI/wellness softness.

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

### No decorative gradients

`linear-gradient` is forbidden except in:
- Zone/fitness position bars (existing pattern, data-carrying)
- Area chart fills (existing pattern, data-carrying)
- The 3px accent stripe on illness/injury banners (existing only — do not add new ones)

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

- **Never use `items-end`** — bottom-anchored sheets look broken on desktop and are hard to dismiss on iOS.
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

### Standard pill button (header row)

```html
<button style="height:32px;padding:0 12px;border-radius:16px;border:1px solid var(--c-border);
               background:transparent;font-size:11px;font-weight:600;color:var(--c-muted);
               cursor:pointer;letter-spacing:0.02em">Label</button>
```

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
