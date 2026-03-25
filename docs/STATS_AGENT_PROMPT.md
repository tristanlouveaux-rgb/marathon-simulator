# Agent Prompt — Stats Redesign

You are rebuilding the Stats page of a marathon training app. Everything you need is below. Read all of it before writing a single line of code.

---

## Your task

Rebuild `src/ui/stats-view.ts` according to the spec in `docs/STATS_REDESIGN_PLAN.md`.

Read the plan doc first, then read the current implementation, then build.

---

## Codebase context

- **Stack**: TypeScript + Vite + Tailwind CSS. Vanilla DOM manipulation — no React, no framework. UI is built by constructing HTML strings and setting `innerHTML`, or by creating/appending DOM elements directly. Match this pattern exactly.
- **Path alias**: `@/*` maps to `src/*`
- **State**: `getState()` from `@/state` — single object, read-only. All the data you need is already in state. Do not add new state fields.
- **Units**: All distances via `formatKm(km, unitPref)`, all paces via `fp()` or `formatPace()`. Never hardcode `km`, `/km`, or `/mi`.
- **Tailwind**: Use utility classes. Light theme — background `bg-[#f5f0eb]` or `bg-white`, text `text-gray-800`, accent green `#22c55e`.

---

## Files to read (in this order)

1. `docs/STATS_REDESIGN_PLAN.md` — the full spec. This is your source of truth.
2. `src/ui/stats-view.ts` — current implementation. **This file is large (~1800 lines). Read it in chunks of 150 lines using offset + limit parameters. Do not try to read it all at once.**
3. `src/calculations/fitness-model.ts` — skim only: understand the return shapes of `computeFitnessModel()`, `computeACWR()`, `computeSameSignalTSB()`, `computeWeekRawTSS()`, `computePlannedWeekTSS()`. Do not modify this file.
4. `src/calculations/readiness.ts` — skim only: understand `computeReadiness()`, `readinessColor()`, `drivingSignalLabel()`. Do not modify this file.

---

## Critical constraints — do not break these

1. **No bar charts anywhere.** Line charts and scale bars (gradient zone bars) only.
2. **Do not modify** `src/calculations/fitness-model.ts`, `src/calculations/readiness.ts`, or any file outside `src/ui/stats-view.ts`. All changes go in stats-view.ts only.
3. **Scale bar marker fix is non-negotiable.** The current bug: the ⓘ info circle is always anchored at the far left of every scale bar regardless of the actual value. Fix this by computing marker position as a percentage and absolutely positioning a floating dot + value badge. Full spec in the plan doc.
4. **No tabs inside detail pages.** Each detail page is a single scroll. The 8w/16w/total range toggle is a set of small pill buttons, not tabs.
5. **Reuse existing helper functions** — `getChartData()`, `computeCurrentVDOT()`, `runKmFromWeek()`, `last7()`, `avg()` are already in stats-view.ts. Use them.
6. **Charts use SVG** — consistent with existing implementation. Use the existing SVG chart helpers already in stats-view.ts if they exist; otherwise build minimal SVG line charts.

---

## Page structure (summary — full detail in plan doc)

```
Stats opening screen
├── Progress card      → tap → Progress detail page
├── Fitness card       → tap → Fitness detail page
├── Readiness card     → tap → Readiness detail page
└── Summary (flat)     → no tap-through

Progress detail (single scroll)
├── Phase timeline
├── Load chart (Signal B line, 8w/16w/total)
├── Running distance chart (line, same toggle)
└── CTL chart (line, same toggle)

Fitness detail (single scroll)
├── Scale bars: Running Fitness / Aerobic Capacity / Lactate Threshold
└── VDOT trend chart (line, 8w/16w/total)

Readiness detail (single scroll)
├── Scale bars: Freshness / Short-Term Load / Load Safety / Fitness Momentum
├── TSB trend chart (line)
└── Recovery & Physiology (expanded, not in accordion)
```

---

## How to approach this

1. Read the plan doc fully.
2. Read stats-view.ts in chunks — understand the existing rendering pattern, helper functions, navigation wiring, and SVG chart code.
3. Plan your changes mentally: which functions to keep, which to replace, what new functions to write.
4. **Build the opening screen first** — get the four sections rendering correctly before touching the detail pages.
5. **Fix the scale bar marker** as a discrete step — find the existing scale bar rendering function and fix the marker positioning there. This affects all six scale bars across Fitness and Readiness detail pages.
6. Build Progress detail, then Fitness detail, then Readiness detail.
7. Run `npx tsc --noEmit` after all changes. Fix all type errors before finishing.

---

## After you finish

Update these two docs (required by project rules):
- `docs/FEATURES.md` — update the Stats section to reflect the new structure
- `docs/CHANGELOG.md` — add a bullet under today's date (2026-03-19)

---

## Definition of done

- [ ] Opening screen renders four sections: Progress, Fitness, Readiness, Summary
- [ ] Progress card shows race arc (race mode) or tier arc (general mode)
- [ ] Fitness card shows compact VDOT trend line
- [ ] Readiness card shows Freshness scale bar with correctly positioned floating marker
- [ ] Summary section shows forecast times (race mode) and training paces
- [ ] All three detail pages scroll cleanly with no tabs
- [ ] Scale bar markers are floating dots positioned at the correct value on every bar
- [ ] All charts are line charts (no bars)
- [ ] 8w/16w/total toggle works on all charts
- [ ] `npx tsc --noEmit` passes with zero errors
