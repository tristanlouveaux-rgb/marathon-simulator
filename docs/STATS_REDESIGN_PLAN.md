# Stats Redesign — Implementation Plan

> This document is the build spec for an agent. Read it fully before touching any code.
> Primary file: `src/ui/stats-view.ts`
> Run `npx tsc --noEmit` after changes to verify no type errors.

---

## Mental Model

Stats is organised around three pillars: **Progress**, **Fitness**, **Readiness**.
Everything belongs to one of these. The opening screen shows one card per pillar + a flat Summary section.
Tapping a card drills into a full detail page (single scroll, no tabs).

---

## Opening Screen Structure

Four sections, stacked vertically:

### 1. Progress Card
- **Race mode** (`s.raceMode === true` or `s.marathonDate` set):
  - Horizontal arc/timeline from plan start → race day
  - Today's position marked on the arc
  - Forecast finish time badge (from `s.forecastTime` — format as `ft(s.forecastTime)`)
  - Pill: "On track ↗" (green) / "Slightly behind" (amber) / "Off track ↓" (red)
  - Logic: compare `s.forecastTime` to `s.goalTime` — if within 5 min = on track, 5–15 min behind = slightly behind, >15 min = off track
- **General fitness mode** (no race):
  - Arc filling toward next athlete tier
  - Current tier label (Building / Foundation / Trained / Well-Trained / Performance / Elite)
  - "X% to [next tier]" — derived from CTL position within tier band
  - Tier thresholds (CTL daily-equivalent = weeklyTSS/7): Building <30/7, Foundation 30–60/7, Trained 60–90/7, Well-Trained 90–120/7, Performance 120–150/7, Elite 150+/7
  - Tap → Progress detail page

### 2. Fitness Card
- Compact VDOT trend line chart (last 8 weeks, from `s.vdotHistory`)
- Current VDOT value + tier label (use existing `vt()` helper)
- Tap → Fitness detail page

### 3. Readiness Card
- Single **Freshness scale bar** with floating marker at correct position
- Score value + label (e.g. "+26 · Peaked")
- Freshness = TSB from `computeSameSignalTSB()` — map to zones: Overtrained (<-30), Fatigued (-30 to -10), Recovering (-10 to 0), Fresh (0 to 15), Peaked (15 to 25), Overreached (>25)
- Tap → Readiness detail page

### 4. Summary (flat, no tap-through)
- Forecast times (race mode): Marathon · Half · 10K · 5K derived from current VDOT via `vt()`
- Training Paces: Easy · MP · Threshold · VO2max — from `fp()` helper and current VDOT
- Display as a clean two-column grid of label + value rows
- General fitness mode: show training paces only (no forecast times)

---

## Progress Detail Page

Single scroll, back button at top. No tabs.

Sections in order:

### Phase Timeline
- Horizontal bar from week 1 → total weeks (`s.tw`)
- Colour bands per phase: Base (blue), Build (orange), Peak (red), Taper (purple)
- Today's week marked with a dot + "Week N"
- Phase name label below current position
- Source: `s.wks[i].ph` for each week's phase

### Load Chart (Signal B)
- Line chart (NOT bar chart) — weekly Signal B TSS over time
- Time range toggle: **8w / 16w / total** — reuse existing `ChartRange` type and `getChartData()` logic
- Data: `historicWeeklyRawTSS` for history, `computeWeekRawTSS()` for current week — already in `getChartData()`
- Y-axis: 0 to max+10%, labelled
- X-axis: week labels (e.g. "Mar 3", "Mar 10")
- Current week highlighted with a dot

### Running Distance Chart
- Line chart — weekly running km over time
- Same 8w/16w/total toggle (shared state with Load chart above)
- Data: `historicWeeklyKm` for history, `runKmFromWeek()` for current week — already in `getChartData()`
- Y-axis: 0 to max+10%

### CTL Chart
- Line chart — 42-day Signal A chronic load (running fitness) over time
- Computed from `computeFitnessModel(s)` — use `.ctl` value
- Show last 8/16/all weeks of CTL snapshots
- Add a horizontal reference line at current tier boundary
- Label: "Running Fitness (CTL) — 42-day average"

---

## Fitness Detail Page

Single scroll, back button at top. No tabs.

Sections in order:

### Scale Bars — Progress Section
Three scale bars with **fixed floating markers** (see Scale Bar Fix below):
1. **Running Fitness** — CTL daily-equivalent (weeklyTSS/7), zones: Building/Foundation/Trained/Well-Trained/Performance/Elite
2. **Aerobic Capacity** — VDOT, zones same as current implementation
3. **Lactate Threshold** — LT pace from `vt()`, zones same as current

### VDOT Trend Chart
- Line chart — VDOT history from `s.vdotHistory`
- Same 8w/16w/total toggle
- Y-axis: VDOT score (e.g. 40–60 range)
- Annotate current value with a dot + label

---

## Readiness Detail Page

Single scroll, back button at top. No tabs.

Sections in order:

### Scale Bars — Training Load Section
Four scale bars with **fixed floating markers**:
1. **Freshness** — TSB value, zones: Overtrained / Fatigued / Recovering / Fresh / Peaked
2. **Short-Term Load** — ATL (7-day acute load), zones: Low / Moderate / High / Very High
3. **Load Safety (Injury Risk)** — ACWR ratio from `computeACWR()`, zones: Safe / Elevated / High Risk
4. **Running Fitness Momentum** — CTL trend (delta over 4 weeks), zones: Declining / Stable / Building / Overreach

### TSB Trend Chart
- Line chart — Freshness (TSB) over last 8 weeks
- Horizontal reference lines at zone boundaries (-10, 0, 15, 25)
- Zone bands as subtle background colours

### Recovery & Physiology
- Sleep score + trend (from `s.physiologyHistory`)
- HRV trend
- RHR trend
- Existing implementation is fine — keep it, just ensure it renders expanded (not in an accordion)

---

## Scale Bar Marker Fix (CRITICAL)

**Current bug**: The ⓘ info circle is used as the position marker but is always anchored to the left side of the bar, regardless of the actual value. The value appears at the far right as text, completely disconnected from its position on the scale.

**Fix**: Replace the ⓘ-as-marker pattern with a proper floating marker:

```
[============================●===========]
                             ↑
                        floating dot + value badge above
```

Implementation:
- Compute marker position as a percentage: `pct = (value - minValue) / (maxValue - minValue) * 100`
- Clamp to 2%–98% to avoid overflow
- Render a `div.marker` with `left: ${pct}%` absolute positioning inside a `position: relative` container
- Above the marker: a small badge showing the value + label (e.g. "+26 · Peaked")
- The ⓘ info circle moves to next to the **row label** (e.g. "Freshness ⓘ"), not on the bar
- Zone labels (Overtrained, Fatigued, etc.) stay below the bar as now

Each scale bar has different min/max/zone mappings — document them clearly in code.

| Bar | Min | Max | Notes |
|-----|-----|-----|-------|
| Freshness (TSB) | -60 | 40 | |
| Short-Term Load (ATL) | 0 | 150 | |
| Load Safety (ACWR) | 0 | 2.0 | |
| Fitness Momentum | -20 | +20 | CTL delta over 4w |
| Running Fitness (CTL daily) | 0 | 25 | weeklyTSS/7 |
| Aerobic Capacity (VDOT) | 30 | 75 | |
| Lactate Threshold (pace) | inverted — faster = better | | |

---

## Chart Requirements (all charts)

- **Line charts only** — no bar charts
- Use SVG (consistent with existing implementation in stats-view.ts)
- Smooth curves (use cubic bezier or monotone interpolation)
- Dots on data points, highlighted on current week
- Minimal axes — just enough to orient (no gridlines, or very faint)
- Time range toggle (8w / 16w / total) shared per page — one toggle controls all charts on that page
- Empty state: if fewer than 3 data points, show "Not enough data yet" placeholder

---

## Navigation Wiring

- Opening Stats screen renders the four sections
- Each of Progress / Fitness / Readiness cards has a tap handler → renders the detail page
- Detail pages have a back `←` button → returns to Stats opening screen
- No tabs inside detail pages
- Summary section has no tap-through

---

## What NOT to Change

- Do not change `getChartData()`, `computeCurrentVDOT()`, `computeFitnessModel()`, `computeACWR()`, `computeSameSignalTSB()` — reuse as-is
- Do not change the tab bar or navigation to other pages (Home, Plan, etc.)
- Do not change `src/calculations/fitness-model.ts` or `src/calculations/readiness.ts`
- Do not add bar charts anywhere — line charts and scale bars only
- Do not add new state fields — all data is already available in state

---

## Doc Updates Required After Build

- Update `docs/FEATURES.md` — Stats section
- Add bullet to `docs/CHANGELOG.md` under today's date

---

*Spec agreed: 2026-03-19*
