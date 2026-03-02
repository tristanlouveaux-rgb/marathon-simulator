# Mosaic — Full UI/UX Redesign Plan
*Principal product design spec. Written Feb 2026. Implement phase by phase.*

---

## 0. North Star

> **One truth per screen. Every screen must communicate its core message in 5 seconds.**

The plan adapts automatically. The UI's job is trust, not data density.

---

## 1. Design System

### 1.1 Colour Palette

| Token | Value | Use |
|-------|-------|-----|
| `--c-bg` | `#FDFCF7` | App background (cream) |
| `--c-surface` | `#FFFFFF` | Cards |
| `--c-black` | `#0F0F0F` | Primary text, borders |
| `--c-muted` | `#555555` | Labels, secondary text |
| `--c-accent` | `#2563EB` | CTA buttons, active nav, highlights |
| `--c-border` | `rgba(0,0,0,0.12)` | Inner borders (lighter than outer) |
| `--c-border-strong` | `#0F0F0F` | Outer card borders (Vergia style) |

**Status colours — ratio-based, never absolute values:**

| Status | Colour | Token | Trigger |
|--------|--------|-------|---------|
| Neutral / building | `#9CA3AF` grey | `--c-neutral` | < 70% of target |
| On track | `#16A34A` green | `--c-ok` | 70–110% of target |
| Caution | `#D97706` amber | `--c-caution` | 110–130% of target |
| Warning | `#DC2626` red | `--c-warn` | > 130% of target |

**Rule: red is never a background. It is only a bar-cap segment or a pill border.**

**Injury risk bar** (special — gradient, not status-coded):
- Left → right: `#22C55E` → `#EAB308` → `#EF4444`
- Thumb/fill position driven by ACWR ratio mapped to 0–100%

### 1.2 Typography

```
Font: 'Helvetica Neue', Helvetica, Arial, sans-serif
Mono labels: 'Courier New', Courier, monospace

--t-hero:   36px / weight 400 / tracking -0.04em   (big stat numbers)
--t-title:  20px / weight 500 / tracking -0.02em   (page headings)
--t-section:16px / weight 400                       (card headings)
--t-label:  12px / weight 600 / UPPERCASE / tracking 0.07em / opacity 0.5
--t-body:   15px / weight 400 / line-height 1.4
--t-caption:11px / weight 400 / muted
```

### 1.3 Component Rules

- **Cards**: `1px solid var(--c-border-strong)` / `border-radius: 0` (sharp, like Vergia) / `background: white` / no shadow
- **Progress bars**: height `5px` / `border-radius: 100px` / track `rgba(0,0,0,0.08)`
- **Buttons — primary**: `background: var(--c-accent)` / `border-radius: 100px` / `padding: 14px 24px` / white text
- **Buttons — secondary**: transparent / `1px solid var(--c-black)` / `border-radius: 100px` / black text
- **Pills**: `border-radius: 100px` / `padding: 4px 10px` / `font-size: 11px` / `font-weight: 600`
- **Section dividers**: `1px solid var(--c-border)` (light), never strong black

### 1.4 Motion

- Page transitions: none (instant, Capacitor native handles)
- Accordion open/close: `max-height` transition 200ms ease
- Bar fill: `width` transition 400ms ease on mount (one-shot)
- Bottom sheets: slide up 250ms ease-out

---

## 2. Tab Structure

**4 tabs** (Account moves to header):

```
[ Home ]  [ Plan ]  [ Record ]  [ Stats ]
```

- **Home**: house icon — default tab on open
- **Plan**: calendar icon — weekly training plan
- **Record**: filled circle icon — start/log a workout
- **Stats**: bar chart icon — analytics

**Account**: avatar icon in top-right of Home header. Tapping navigates to Account view (no tab bar change needed).

### Tab Bar Spec

```
Border-top: 1px solid var(--c-black)
Background: var(--c-bg)
Padding: 12px 24px 24px (+ safe-area-inset-bottom)
Icon: 24px / stroke-width 1.5 / stroke black
Label: 10px / uppercase / letter-spacing 0.07em
Active: opacity 1 / icon filled or bold stroke
Inactive: opacity 0.35
```

---

## 3. Home Tab

### 3.1 Above Fold

**Header row**
```
[Mosaic]                          [○ Account]
```
- "Mosaic" — 22px / weight 500
- Account button — 32px circle, `1px solid var(--c-black)`, initials or avatar

**Greeting** *(optional, can be cut if space-tight)*
```
Good morning.                           14px muted
```

---

**This Week — 3 progress bars**

```
WEEKLY GOAL                    4 / 5 sessions
████████████████░░░░            (80% green)

DISTANCE                       42.5 / 50 km
██████████████████░░            (85% green)

TRAINING LOAD                  186 / 219 TSS
█████████████████░░░            (85% green)
```

Bar colour rules (same threshold system for all 3):
- `0 → 70%` of target: `--c-neutral` grey
- `70% → 110%`: `--c-ok` green
- `110% → 130%`: `--c-caution` amber cap segment over green
- `> 130%`: `--c-warn` red cap segment; bar clamped, `+X%` label at right edge

**Status pill** — single pill below the bars, load-based:

| ACWR | Pill text | Colour |
|------|-----------|--------|
| < 0.8 | "Building Consistency" | Grey |
| 0.8–1.1 | "On Track!" | Green |
| 1.1–safe upper | "Training Hard!" | Amber |
| > safe upper | "Consider slowing down" | Amber (pill only, not card) |

*Note: never use red pill — amber is the maximum on the pill. Red only appears as a bar cap.*

---

**Injury Risk bar**

```
INJURY RISK
●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┤
↑ Low                         High
```

- Full-width gradient bar: green → yellow → red
- Filled thumb at ACWR-mapped position (no text percentage)
- One sentence below: "Your load is within safe range." / "You're accumulating load fast — prioritise sleep and easy days." / "Reduce load before next week."
- During baseline building (< 4 weeks): grey bar + "Building your baseline — check back in week 4."

---

**Next Workout card**

```
┌─────────────────────────────────────────┐
│ THURSDAY · TODAY              [▶ Start] │
│                                         │
│ Tempo Run                               │
│ 5 × 1km @ 4:05/km · ~45 min            │
│                                  [Plan →]│
└─────────────────────────────────────────┘
```

- Full-width card, `1px solid var(--c-black)`
- Day label: monospace uppercase label
- Workout name: `--t-title` (20px)
- Description: `--t-body` muted
- `[▶ Start]` button: accent blue, pill shape, right-aligned in header row
- `[Plan →]` text link: bottom-right, navigates to Plan tab at that workout
- If today's workout already done: card shows tomorrow's workout, faded label "Tomorrow"
- If rest day: card shows next workout day with lighter treatment

---

**Race Countdown** *(only shown if race date set)*

```
         42
    days to your marathon
```

- Number: `--t-hero` (36px), centered
- Label: `--t-caption` muted, centered
- Subtle — not a card, just a text block with generous padding

---

**Actions row** *(sticky above tab bar when pending)*

```
[↻ Sync Garmin]    [✓ Complete Week]
```

- Two secondary buttons, side by side
- Only visible when: Garmin has unsynced data OR week is eligible for completion
- Disappear when neither condition is true (don't waste permanent space)

---

### 3.2 Below Fold

**Recent Activity** — last 2–3 runs, Vergia list style:

```
├─ Morning Run          5.0 km    →
├─ Endurance Run       12.5 km    →
├─ Intervals           45 min     →
```

Each row:
- Icon (sport) left
- Name + date subtitle
- Distance or duration right
- Arrow → navigates to Activity Detail page

---

## 4. Plan Tab

### 4.1 Header

```
Week 6 of 16 · Base Phase       [< >]
```

- Week navigation: `[<]` and `[>]` tap targets (44px min) on web / swipe on iOS
- Phase label: muted, monospace

### 4.2 Weekly Calendar Strip

7 day pills in a horizontal row:

```
M    T    W    T    F    S    S
○   ✓   ──   ●   ○   ○   ──
```

- `●` = today (filled circle, accent blue)
- `✓` = completed (filled, green)
- `○` = upcoming run day
- `──` = rest day
- `×` = skipped / missed
- Tap any pill → smooth-scrolls to that day's card below

### 4.3 Workout Cards

Vergia-style list, one card per training day:

```
├─────────────────────────────────────────┤
│ MON  ✓ completed                        │
│ Easy Run                    10 km    →  │
├─────────────────────────────────────────┤
│ TUE  ✓ completed                        │
│ Threshold Intervals         45 min   →  │
├─────────────────────────────────────────┤
│ WED  ── rest                            │
├─────────────────────────────────────────┤
│ THU  ● today                            │
│ Tempo Run                  ~45 min      │
│                       [▶ Start workout] │
├─────────────────────────────────────────┤
│ FRI  ○ upcoming                         │
│ Long Run                    18 km    →  │
├─────────────────────────────────────────┤
```

Card anatomy:
- Day label: monospace uppercase, muted
- Status: small label (completed / today / upcoming / rest)
- Workout name: 16px, weight 400
- Distance or time: right-aligned, muted
- Arrow `→`: only on completed or upcoming (navigates to detail)
- Today's card: slightly elevated (white bg, full black border), shows `[▶ Start workout]` button
- Completed: `opacity 0.7` on name/distance, green checkmark icon
- Rest day: compact row, no arrow

**Alternative workouts**: small "+" text link under today's card — "Start a different workout" → navigates to Record tab with workout picker

**Garmin sync / Complete Week**: appear as action rows within the card list when relevant (after last workout of the week, or when sync is available) — not a separate persistent UI element.

---

## 5. Activity Detail Page

*Navigated to from: Plan tab workout arrow, Home recent activity list.*
*Back button returns to origin.*

### 5.1 Header

```
←   Tempo Run                   Thu 20 Feb
```

### 5.2 Zone Bars (always first)

Three horizontal bars — the primary story of what kind of training this was:

```
BASE (aerobic)
████████████████████░░░░░   78%
Plan target ↑              72%

THRESHOLD
████████░░░░░░░░░░░░░░░░░   18%
Plan target ↑              20%

INTENSITY (VO2)
███░░░░░░░░░░░░░░░░░░░░░░    4%
Plan target ↑               8%
```

Bar colour rules:
- Bar fill: always `--c-accent` blue (these are not status bars — they're zone composition)
- Plan target tick: vertical mark at planned %, `--c-muted` grey
- Divergence text (only if > 10% off plan): below bar, 11px muted — e.g., "4% below target — not unusual for a hard session."
- If no zone data (no HR source): grey bar with "Connect heart rate for zone breakdown"

### 5.3 Stats Grid

2-column grid, no colours — pure numbers:

```
Duration          Avg Pace
45:12             4:08/km

Distance          Avg HR
10.2 km           158 bpm

Elevation         Calories
+124 m            420 kcal
```

### 5.4 Map

Full-width, rounded top corners only at border edge.
- Shows GPS route if available
- Split markers (km dots)
- Tapping opens full-screen map
- If no GPS data: section hidden (no empty state shown)

### 5.5 Notes / Effort

```
RPE: 7/10    "Felt good on intervals, struggled on rep 4"
```

---

## 6. Stats Tab

### 6.1 Above Fold

**Page heading**

```
Your last 8 weeks                   20px / weight 500
Load is building steadily           14px / muted / updates on tab focus
— keep the consistency.
```

Narrative sentence is a 3×3 matrix (direction × ACWR status = 9 specific strings). See §6.5.

---

**Primary chart: 8-week TSS bar chart**

- Chart type: vertical bar chart (discrete weeks = bars, not lines)
- Height: 180px mobile / 220px laptop
- Width: 100% container
- X-axis: week labels ("Jan 6", "Jan 13"...) — current week bold or marked ★
- Y-axis: implicit only — no labels, 2–3 dotted grey gridlines at round numbers
- Bars:
  - Past weeks within ±10% of CTL: `--c-ok` green
  - Past weeks > CTL: green body + amber/red cap (same threshold rules as bars above)
  - Past weeks: `--c-neutral` grey if below 70% of CTL
  - Current week: `--c-accent` blue (always distinct)
  - Incomplete current week: blue with subtle diagonal hatch
- CTL baseline: solid grey line, 1.5px, "CTL" pill label at right end
- No plan target line on this chart (moved to Advanced)
- Tap/hover: bottom sheet on mobile with that week's TSS, plan target, CTL, % vs CTL
- Clamping: if bar exceeds height, cap and show "+X%" badge above bar

Cross-training: stacked on bar as purple segment above blue running segment. No separate chart.

---

**Two cards** (side by side)

**Card: Week vs Baseline**
```
WEEK VS BASELINE
+12%
above your normal

● On track          ←  green pill
Keep this week's plan as-is.
```

Thresholds:
- `> −20%`: "Low" (grey pill) — "Good time to add a quality session."
- `±10%`: "On track" (green pill) — "Keep this week's plan as-is."
- `+10–30%`: "Elevated" (amber pill) — "High load. Watch how you feel tomorrow."
- `> +30%`: "High load" (amber pill, red border) — "Reduce one session before next week."

**Card: Weekly Km**
```
WEEKLY KM
52 km

● On target         ←  green pill
Volume is right where it needs to be.
+ ~8 km cross-training
```

Thresholds: vs planned km (not CTL):
- `< 50%`: "Light week" (grey)
- `50–90%`: "Building" (grey→green)
- `90–110%`: "On target" (green)
- `> 110%`: "Above target" (amber)
- `> 130%`: "Well above" (amber, red border)

Cross-training line: `+ ~X km cross-training` shown in 11px muted below value (volumeTransfer applied). Hidden if 0.

---

### 6.2 Below Fold — "How it's calculated"

Tap trigger: `How it's calculated  ↓` — full-width, 14px, blue underline text

**Chart view switcher** (segmented control, 3 options):
- [Training Load] — default, same chart as above
- [Kilometres] — same 8-bar chart, blue running km + purple cross-training km stacked
- [Zone Breakdown] — stacked bar chart (Base/Threshold/Intensity as % of TSS per week); disabled and greyed if no HR data with note "Connect a heart rate source for zone data"

**Explainer copy** (3 bullets, 13px muted):
- Training Load (TSS) measures how hard each week was — duration × intensity combined.
- The line is your CTL — a 42-day average that represents your current fitness level.
- Week vs Baseline = this week's TSS ÷ CTL. Values above 1.30 are where injury risk rises.

**8-week summary row** (no colour — pure info):
```
Avg TSS/wk: 74    Avg days/wk: 5.2    Consistency: 87%
```
Caption: "Over your last 8 weeks" (11px muted)

---

### 6.3 Advanced Section — "Detailed stats ↓"

Visual separator: full-width `1px` rule + icon ⚙ + descriptor "For coaches and data-driven athletes" (11px muted).
State: persisted in localStorage (`mosaic_stats_advanced_open`). Defaults closed.

**Training Bar 1: Km vs Plan**

```
KM THIS WEEK                              52 km
[████████████████████████▌░░]  +8%
                              ↑ Plan: 48 km
```

- Horizontal bar, 32px height
- Green fill up to plan target
- Amber segment beyond plan target to 130%
- Red segment beyond 130%
- Plan target tick (vertical mark)
- Clamped at 150% — shows "+X%" badge at right edge

**Training Bar 2: TSS vs Plan**

```
TRAINING LOAD                             91 TSS
[░░░░░░░░░██████████████████▌░░]
          ↑ CTL: 72    ↑ Plan: 85
```

- Grey from 0 to CTL ("your baseline")
- Green from CTL to plan target ("intended progression")
- Amber from plan target to plan × 1.10
- Red above plan × 1.10
- Two ticks: CTL position (labelled "CTL" 9px) + Plan TSS position
- Recovery week case: if plan target < CTL, green zone collapses to tick only, bar is grey

**Training Bar 3: Zone Split vs Plan**

```
BASE · THRESHOLD · INTENSITY
[████████████████████▓▓▓▓▓▓███]
 72% base · 19% threshold · 9% intensity
 Plan: 75% · 15% · 10%
```

- Proportional split bar (% of total TSS, not absolute)
- Segment colours: Base = green, Threshold = amber, Intensity = red
- Plan targets shown as plain text below (not ghost bar)
- Divergence: `⚠` next to any zone > 10% off plan, with tooltip "Mosaic planned X% intensity — you've done Y%. Fine once, but compounds over time."
- No HR source: grey bar + "Connect heart rate for zone breakdown"

**PMC Section** (numbers only — no dials):

```
CTL    ATL    TSB    ACWR
 72     81    −9    1.12×
```

ACWR bar (gradient, same as Home injury risk bar — these are the same metric):
```
───────────────────●────────────────────
0.8              1.12×               1.5+
```
Status text: "Manageable load" / "Caution — monitor this week" / "High — reduce load"
Athlete tier: "Your level: Trained recreational · Safe increase: up to 30% above baseline"

**Race Prediction** (if applicable, collapsed here):
- Starting → Today → Forecast time, 3-column grid
- Progress bar to goal

**Current Paces** (collapsed):
- 2-col grid: Easy / Marathon / Threshold / VO2 — no colour coding, just numbers

**Fitness Trend** (collapsed):
- VDOT sparkline (existing logic, restyled)
- LT pace improvement

**Recovery & Physiology** (collapsed, only if data exists):
- Resting HR / HRV / Sleep / Watch VO2 — restyled metric cards

---

### 6.4 Edge States

| State | Chart | Cards | Narrative |
|-------|-------|-------|-----------|
| < 4 weeks data | No CTL line; grey pill on chart: "Baseline from week 4" | Value: "—" Status: "Building" | "Every session builds your base." |
| Missing week | Empty bar slot (no label shame) | Normal | "Getting back into rhythm — ease in." |
| Beginner (< 40 TSS avg) | Y-axis scales to data, never fixed | Status never "Low load" in red — always grey "Building" | "Every session makes a difference." |
| High volume (> 150 TSS) | Y-axis scales to data | Ratio-based colours, never absolute | "High volume — recovery is the performance lever." |
| Cross-training week | Blue + purple stacked bar (not empty) | "+ ~Xkm cross-training" sub-value | "Load is steady — cross-training filling the gap." |
| Return to run / injury | Amber banner above chart (non-dismissible) | "Return protocol" amber pill | "Load is light intentionally — follow the plan." |

---

### 6.5 Narrative Sentence Matrix (all 9, production copy)

| Direction \ ACWR | Safe | Caution | High |
|------------------|------|---------|------|
| **Building** | "Load is building well — stay consistent." | "Load is rising fast — today's easy run matters." | "Load is spiking — protect recovery before next week." |
| **Steady** | "Load is holding steady — you're in a good rhythm." | "Steady week, but load is elevated — stay easy today." | "Load is heavy and not dropping — don't add sessions." |
| **Easing** | "Load is easing off — good, you've earned it." | "Load is easing but still elevated — trust the dip." | "Load is too heavy — don't add sessions this week." |

---

## 7. Implementation Phases

### Phase 1 — Design System (global theme)
- New CSS variables in `src/main.ts` or a new `src/styles/theme.css`
- Remove all `bg-gray-*`, `text-gray-*`, `border-gray-*` Tailwind classes
- Replace with cream/black/blue system
- Update `tab-bar.ts` to new 4-tab structure
- Update bottom nav styling

*Acceptance: app background is cream, tab bar is cream/black, no dark backgrounds anywhere.*

### Phase 2 — Home Tab (new file: `src/ui/home-view.ts`)
- 3 progress bars (sessions, km, TSS) with threshold colour system
- Status pill (load-based)
- Injury risk bar
- Next workout card (wired to current week's today/next workout)
- Race countdown (if `s.raceDate` set)
- Recent activity list (Vergia style)
- Garmin sync / complete week action row (conditional)

*Acceptance: home communicates weekly status in 5 seconds. No red backgrounds.*

### Phase 3 — Plan Tab redesign
- Weekly calendar strip (7-day pill row)
- Vergia-style workout card list
- Today card with Start button
- Week navigation (< >)
- Rest day compact rows

*Acceptance: user can see the full week at a glance and tap Start on today's workout.*

### Phase 4 — Activity Detail page (new file: `src/ui/activity-detail.ts`)
- Zone bars (Base / Threshold / Intensity) vs plan
- Stats grid (duration, pace, HR, etc.)
- Map section (if GPS data)
- Notes / RPE

*Acceptance: tapping any completed workout from Plan or Home navigates to this page with correct data.*

### Phase 5 — Stats Tab redesign
- Replace existing `stats-view.ts` entirely
- Narrative sentence (computed from ACWR + direction)
- 8-week bar chart (new SVG/CSS implementation — no lib)
- Two cards (Week vs Baseline, Weekly Km)
- Collapsed "How it's calculated" section with chart switcher
- Advanced accordion with 3 training bars + PMC numbers
- All existing sections (race prediction, paces, fitness, physiology) folded into Advanced accordion

*Acceptance: Stats above-fold communicates one clear message. No dials. No red backgrounds.*

---

## 8. What We Are Explicitly Removing

| Removed | Replaced by |
|---------|------------|
| Half-circle gauge/dial SVGs | PMC numbers row (CTL / ATL / TSB / ACWR) |
| `bg-gray-900` dark theme | Cream/white light theme |
| Rainbow arc ACWR dial | Gradient bar (green→red) |
| "Training Balance" section name | "Week vs Baseline" card (simpler) |
| Injury risk percentage number | Gradient bar position (no %) |
| Fitness section on main Stats landing | Folded into Advanced accordion |
| Multiple coloured bars on current week view | Single rail with threshold coloring |
| Garmin sync as a Stats element | Action row on Home / Plan |

---

## 9. Final Design Decisions (locked)

1. **Accent colour**: `#4E9FE5` — powder blue. Warm and airy against cream, confident enough for CTAs. Interactive states (hover/pressed) use `#2E7EC4`.
2. **Card radius**: `4px` on content cards (barely perceptible rounding — structural, not clinical). `100px` on all buttons and pills (full pill — Vergia's signature contrast). Tab bar keeps hard `1px solid #0F0F0F` top border.
3. **Card borders**: Two tiers — default inner cards `1px solid rgba(0,0,0,0.15)` (soft), elevated / today cards `1px solid #0F0F0F` (full black for emphasis).
4. **Race countdown**: Always visible on Home when race date is set.
5. **Week "completion"**: Manual action. Appears as an action row at the bottom of the Plan tab workout list when eligible (all workouts rated, or end of week). Not a persistent button.
