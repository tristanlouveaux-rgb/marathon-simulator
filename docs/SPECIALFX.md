# Special Effects & Animation Playbook

Catalogue of visual effects available in the app. Use this as a reference when building or refining UI components.

---

## Animations

### Ring segment stagger
**Used in**: strain-view.ts (strain ring)
**How**: Multiple SVG `<circle>` elements with `stroke-dasharray` + `stroke-dashoffset`, each with an increasing `transition-delay`. Offset starts at `RING_CIRC` (hidden), animates to final position.
**Timing**: `1.4s cubic-bezier(0.2,0.8,0.2,1)`, ~150ms stagger between segments.
**Where to use**: Any ring or gauge that has zones or thresholds. Recovery rings, readiness rings, sleep quality ring.

### Card float-up
**Used in**: strain-view (`.s-fade`), rolling-load-view (`.rl-fade`), freshness-view (`.f-fade`)
**How**: `@keyframes` from `opacity:0; translateY(16px) scale(0.97)` to final position. Each card gets an increasing `animation-delay`.
**Timing**: `0.6s cubic-bezier(0.2,0.8,0.2,1)`, ~60ms stagger.
**Where to use**: Any vertically stacked card layout. Already standard across detail pages.

### Sparkline draw-on
**Used in**: stats-view.ts (all chart line paths with `class="chart-draw"`)
**How**: SVG `<path>` with `stroke-dasharray` set to total path length, `stroke-dashoffset` starts at path length and animates to 0. `animateChartDrawOn()` called after each render uses `getTotalLength()` to measure.
**Timing**: `1.2s ease-out`.
**Where to use**: Any line chart or sparkline. Add `class="chart-draw"` to the path element and call `animateChartDrawOn()` after rendering.
**Implementation**:
```ts
const path = el.querySelector('path.draw-on') as SVGPathElement;
if (path) {
  const len = path.getTotalLength();
  path.style.strokeDasharray = String(len);
  path.style.strokeDashoffset = String(len);
  requestAnimationFrame(() => {
    path.style.transition = 'stroke-dashoffset 1.2s ease-out';
    path.style.strokeDashoffset = '0';
  });
}
```

### Bar cascade (NOT YET BUILT)
**How**: Each bar in a bar chart starts at `height:0` and transitions to final height, with staggered `transition-delay` (left to right).
**Timing**: `0.4s ease-out`, ~50ms stagger per bar.
**Where to use**: Week bars in strain-view, zone bars in freshness-view, any grouped bar chart.

### Number count-up (NOT YET BUILT)
**How**: Animate a number from 0 to final value over the ring fill duration. Use `requestAnimationFrame` loop or CSS `@property` counter.
**Timing**: Match the ring animation (1.4s, same easing).
**Where to use**: Hero numbers inside rings (TSS, recovery score, readiness %).

### Area chart reveal (NOT YET BUILT)
**How**: Clip-path or mask that slides left-to-right, revealing the chart progressively. `clip-path: inset(0 100% 0 0)` → `clip-path: inset(0 0 0 0)`.
**Timing**: `1s ease-out`.
**Where to use**: Stats area charts, forecast charts. Alternative to sparkline draw-on when fill matters more than the line.

---

## Glass / Material Effects

### Clear glass container
**Used in**: strain-view (ring container)
**How**: `background:rgba(255,255,255,0.08); backdrop-filter:blur(40px); border:1px solid rgba(255,255,255,0.2); box-shadow:inset 0 0 30px rgba(255,255,255,0.06)`.
**Where to use**: Hero elements on dark gradient backgrounds. The low opacity + strong blur creates a "floating in glass" effect.

### Frosted pill
**Used in**: strain-view date pills, back/info buttons
**How**: `background:rgba(255,255,255,0.15); backdrop-filter:blur(8px)`. Lighter blur than the glass container.
**Where to use**: Interactive elements over dark backgrounds.

---

## Chart Consistency (Fixed 2026-04-13)

### What was standardised

| Property | Before | After |
|---|---|---|
| Line style | Stats used bezier curves | All charts sharp angular (`M ... L ...`) |
| Stroke colour | Stats used inline `rgba(99,149,255,...)` | Shared constants (`CHART_STROKE`, `CHART_FILL`, etc.) |
| Grid lines | Only rolling-load had them | All major charts use `chartGridLines()` helper |
| Y-axis labels | Stats: `right:4px`, no gutter | All: `right:0`, `padding-right:36px` on wrapper |
| `preserveAspectRatio` | Stats: `="none"` (stretching) | Removed everywhere, proportional scaling |
| `stroke-linejoin` | Missing | `="round"` on all chart paths |

### Remaining minor differences (intentional)

- **Chart height**: varies by chart type — `H=130` (load), `H=100-120` (CTL, distance, TSB), `H=56-72` (physio mini). This is correct since different charts warrant different visual weight.
- **Area fill**: rolling-load is line-only, stats charts have area fill. Different data density warrants different treatment.
- **Semantic colours**: CTL (green), VO2/VDOT/LT (green/red trend), ACWR (red/amber/slate by zone). These are intentionally different from the default slate.
- **Grid lines**: either all charts get subtle grid lines or none do (rolling load has them, stats doesn't)

---

## Principles

1. **Animations should reveal data, not decorate.** A ring filling shows progress. A sparkline drawing shows trajectory. Don't animate things that don't encode information.
2. **Stagger, don't simultaneous.** Sequential reveals create hierarchy. Everything appearing at once is flat.
3. **Match timing to importance.** Hero elements (rings) get 1.4s with dramatic easing. Supporting elements (cards) get 0.6s. Micro-interactions get 0.2s.
4. **Performance-safe.** Only animate `transform`, `opacity`, `stroke-dashoffset`, `clip-path`. Never animate `width`, `height`, `top`, `left`, or layout-triggering properties.
