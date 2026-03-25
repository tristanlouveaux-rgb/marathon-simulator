# Stats Page Redesign — Design Brief

> Working document for iterative discussion. Not a spec — a thinking space.
> Current implementation: `src/ui/stats-view.ts`

---

## What we have right now

Three summary cards → three detail pages:

| Card | Summary shows | Detail shows |
|---|---|---|
| This Week | TSS area sparkline + sessions/distance | Load area chart (8w/16w) + distance stat |
| Fitness | VDOT + trend arrow + mini sparkline + race status | VDOT sparkline large → progress bars → forecast |
| Readiness | Score + label + TSB/ACWR/sleep rows | Load bars + Recovery (sleep/HRV/RHR) |

**Typecheck passes. No known bugs.**

---

## The core problem: it reads like a dashboard, not a coach

Numbers are correct. Layout is clean. But the page doesn't *say* anything. A runner opening Stats wants to leave knowing something they didn't before — not just see the same numbers arranged differently from Home.

The question Stats should answer: **"How is my training going?"**

Right now it answers: "Here are some metrics."

---

## What makes a great athlete stats page

Reference points: Whoop, TrainingPeaks, Strava Fitness & Freshness, Garmin Connect Insights.

What they do well:
- **Whoop**: Single score, plain language, no jargon. You know in 2 seconds if today is a go or no-go.
- **TrainingPeaks**: CTL/ATL/TSB as a *narrative over time* — the shape of the line tells a story.
- **Strava Relative Effort**: Compares this week to *your* normal, not a generic benchmark.
- **Garmin Body Battery**: One number that integrates sleep + HRV + load. No explanation needed.

Common thread: **one dominant signal, context around it, trend over time.**

---

## Problems with the current design

### 1. The sparklines are too small to be meaningful
A 36px-tall area chart with 8 points tells you the shape but not the story. You can see "it went up" but not "it went up 40% over 4 weeks after a recovery dip." The shape is interesting; the sparkline is too compressed to convey it.

### 2. The cards have no hierarchy between them
This Week / Fitness / Readiness are equally weighted. But they're not equal — readiness answers today's question, fitness answers the month's question, and "this week" is a progress meter. Their visual weight should reflect their urgency.

### 3. VDOT is the centrepiece but it feels dry
VDOT 52.1 ↑ means nothing to most runners. What it means is: "you could run a 3:28 marathon today, up from 3:35 four weeks ago." That's the number that should be on the card.

### 4. The "Fitness" and "Readiness" cards feel disconnected
In reality they're deeply related — your fitness determines what load is safe, and your readiness tells you if you can handle it today. Showing them as separate cards misses the relationship.

### 5. Nothing tells the runner what to *do*
Stats pages are for understanding, not just viewing. The best outcome of opening Stats is a decision: "I should push harder this week" or "I need an extra rest day." We're showing the inputs but not surfacing the output.

---

## Design directions to explore

### Direction A — The "Training Story" layout

One full-width chart at the top showing the last 8 weeks as a continuous narrative. Not just load — annotated with events: "rest week", "load spike", "fitness peak". Below it, three compact stat rows (Load | Fitness | Readiness) with single numbers and one-word labels. No cards — just clean information.

Inspired by: financial charting apps (Robinhood, Revolut), where the chart is the hero and numbers live below it.

**Pros**: Immediate visual interest. Chart invites exploration.
**Cons**: Complex to annotate well. Risk of clutter.

---

### Direction B — The "Daily readiness" focus

Lead with today's single answer: a large readiness score (0–100) or a simple green/amber/red signal with one coaching line. "Today: push hard. Your CTL is building and you're fresh." Everything else folds below.

Inspired by: Whoop Recovery screen, Garmin Body Battery.

**Pros**: Answers the most urgent question immediately. Very clean.
**Cons**: Loses the trend/history dimension. Users who want depth have to scroll.

---

### Direction C — The "Race countdown" focus (race mode only)

For users training toward a specific race: the Stats page leads with a race countdown card — "8 weeks to race day · Forecast 3:15 · On track ↗". Below it: a fitness trend line showing CTL building toward race-day peak, then the usual load/readiness content.

Inspired by: Nike Run Club race plan view, Garmin race widget.

**Pros**: Extremely motivating for committed racers. Clear purpose.
**Cons**: Doesn't work for general fitness users. Needs separate layout for continuousMode.

---

### Direction D — The "Dual signal" layout

Split the page into two clear zones:
- **Left/Top half**: Running fitness trend — VDOT and CTL as a combined chart, showing long-term adaptation. The "am I getting fitter?" answer.
- **Right/Bottom half**: Today's readiness — TSB, ACWR, sleep score. The "should I push today?" answer.

Inspired by: TrainingPeaks's dual CTL/ATL chart, but simplified.

**Pros**: Makes the relationship between fitness and readiness explicit.
**Cons**: Harder on mobile with a vertical stack.

---

## Specific elements worth building

### The 8-week narrative chart
A single area chart showing Signal B load over 8 weeks, annotated with:
- Phase transitions (Base → Build → Peak) as background colour bands
- A dashed "target load" line (your weekly baseline)
- VDOT dots overlaid as a secondary axis (small dots, right-aligned scale)
- Current week highlighted

This single chart would replace both the "Training Load" chart in "This Week" detail and the "Running Fitness" chart, unifying them into one story.

### The race forecast timeline (race mode)
A horizontal timeline from plan start to race day, with:
- Today's position marked
- CTL curve projected forward (building to race-day peak)
- Current forecast time as a badge at the end
- "On track" / "Off track" as a pill on the timeline

### Contextual benchmarks
Instead of "VDOT 52.1 · Trained", show "VDOT 52.1 — equivalent to 3:28 marathon pace". Make the number meaningful without requiring the user to understand what VDOT is.

### Weekly comparison sentence
"This week: 12% harder than your 8-week average." One sentence, always visible, no chart needed.

### The "coaching insight" card
One card that synthesises load + readiness + trend into a single coaching sentence and recommendation. Examples:
- "You've had two heavy weeks in a row. An easy day tomorrow will protect your long run quality."
- "CTL is building well. You're 3 weeks from your peak — keep the rhythm."
- "Load dropped 40% this week. If this isn't intentional, consider adding a session."

This exists partially in the narrative sentence today but isn't visually prominent.

---

## Data we have available

Everything we'd need to build any of the above:

| Signal | Source | Used today |
|---|---|---|
| Signal B weekly TSS (8w) | `historicWeeklyRawTSS` | Yes (load chart) |
| Signal A weekly TSS (8w) | `historicWeeklyTSS` | Yes (fitness chart) |
| CTL / ATL / TSB | `computeFitnessModel` | Yes (readiness detail) |
| ACWR | `computeACWR` | Yes (readiness detail) |
| VDOT history | `s.vdotHistory` | Yes (fitness detail sparkline) |
| Race forecast | `s.forecastTime`, `s.currentFitness`, `s.initialBaseline` | Yes (race banner) |
| Phase (Base/Build/Peak/Taper) | `wk.ph` | Partially (timeline fold) |
| Total weeks / current week | `s.tw`, `s.w` | Partially |
| Sleep / HRV / RHR | `s.physiologyHistory` | Yes (recovery section) |
| Readiness score | `computeReadiness` | Yes (readiness card) |
| Zone breakdown | `wk.zoneBase/Threshold/Intensity` | Removed (unreliable) |

---

## Known gap: Stats is disconnected from the Plan page

**Problem**: Stats and Plan currently live as completely separate worlds. A runner looking at their fitness trend on Stats has no way to jump to the plan, and there's no signal on Stats that connects what they're seeing to what's coming up in their training week.

**What should link:**
- "This Week" load card → should be able to tap through to the current week on the Plan page (the runner has context on their load and wants to see what sessions are left)
- VDOT / fitness trend → when the runner sees their fitness improving or declining, a natural next action is "show me my upcoming sessions" or "adjust my plan"
- Race forecast "On track / Off track" → should link directly to the plan so the runner can act on the signal
- Readiness / ACWR warning → already partially wired (ACWR caution routes to the suggestion modal), but a direct "see this week's plan" escape hatch would reduce friction

**Design principle**: Stats explains *why*. Plan shows *what to do about it*. The two pages should feel like two sides of the same view, not two separate apps. At minimum, a persistent "→ View plan" action should be reachable from any Stats detail page.

---

## Open questions

1. **Should Stats have a different layout for race mode vs general fitness?** Race mode has a clear temporal arc (X weeks to race day). General fitness is open-ended. The information hierarchy is different.

2. **What's the right depth model?** Three options:
   - Single scrollable page (no navigation depth) — simple but can get long
   - Current: summary cards → detail pages (two levels) — clean but each card feels isolated
   - Accordion sections on one page — familiar but prone to clutter

3. **Should the 8-week load chart be the hero of the page?** It's the most information-dense element and the only one that shows *change over time*. Treating it as a buried detail (inside "This Week" detail) may be the wrong call.

4. **What does success look like when a runner opens Stats?** Define the 3 things a runner should know after 5 seconds on the Stats page. Today's answer might be: current VDOT, today's readiness, and weekly load vs baseline. Is that right?

5. **How much jargon is acceptable?** TSB, CTL, ACWR mean nothing to casual runners. But serious runners who use TrainingPeaks know them well. Do we use them with explainers, replace them entirely, or offer a "simplified / detailed" toggle?

---

## Suggested next session agenda

1. Pick a direction (A, B, C, or D above) or mix elements
2. Define the "5-second test" — what 3 things should a runner know after 5 seconds
3. Sketch the summary page layout before touching any code
4. Decide on the depth model (single scroll vs current 2-level)
5. Implement, then review with the reviewer agent

---

*Last updated: 2026-03-19*
