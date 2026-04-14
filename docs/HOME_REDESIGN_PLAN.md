# Home Page Readiness Redesign — Agent Handoff

## Decision (confirmed with Tristan, 2026-04-03)

Redesign the Training Readiness section of the home page from three equal-weight rings in a row to a **triangle layout**:

```
        [ READINESS ]         ← large, primary ring, top-centre
   [ SLEEP ]    [ STRAIN ]    ← smaller rings, bottom-left and bottom-right
```

**Design rationale:**
- Readiness is the answer to "how ready am I to train today?" — it is the composite output of Sleep + Strain + Freshness + HRV
- Sleep and Strain are the two visible inputs that explain the Readiness verdict
- The triangle communicates hierarchy without the user doing mental arithmetic
- Tapping any ring drills down to the existing detail page

**What moves off the home view:**
- The Freshness / Injury Risk / Recovery row currently below the rings should move into the Readiness drill-down page (`readiness-view.ts`), not the home page. The home page answer is just the three rings + the CTA copy.

---

## Key Files

| File | Role |
|------|------|
| `src/ui/home-view.ts` | Main home page — Training Readiness section is here |
| `src/ui/strain-view.ts` | Strain detail page (already exists) |
| `src/ui/sleep-view.ts` | Sleep detail page (already exists) |
| `src/ui/readiness-view.ts` (likely) | Readiness drill-down — check if exists, create if not |
| `docs/UX_PATTERNS.md` | **Read before touching any UI** — ring sizes, colours, drill-down patterns |

---

## Current Structure (to change)

In `home-view.ts`, the Training Readiness section currently renders:
- Three equal rings side-by-side: Readiness | Sleep | Strain
- Below rings: a summary text line
- Below that: three columns — Freshness | Injury Risk | Recovery
- CTA button at bottom

## Target Structure

```
Training Readiness
──────────────────
         [ READINESS 39 ]
         Ease Back

   [ SLEEP 78 ]    [ STRAIN 263 ]
   7h 12m          / 103 exceeded

         Take it lighter today     ← CTA stays
```

- Readiness ring: larger (or same size but visually elevated — centred alone on its row)
- Sleep and Strain rings: same size as current, side-by-side below Readiness
- The three-column Freshness/Injury Risk/Recovery row: **remove from home, move into Readiness drill-down page**
- Tapping Readiness ring → opens readiness drill-down showing Freshness, Injury Risk, Recovery detail
- Tapping Sleep → existing `sleep-view.ts`
- Tapping Strain → existing `strain-view.ts`

---

## Readiness Drill-Down Page

If `readiness-view.ts` doesn't exist, create it. It should show:
1. Readiness score + label (Ease Back / Good to Go / etc.)
2. Three sub-signals with their current values:
   - **Freshness** (TSB / Signal B) — current value, trend, plain-language explanation
   - **Injury Risk** (ACWR) — Low/Moderate/High, ratio value
   - **Recovery** (score /100) — current value, main factor (sleep/HRV)
3. "Learn more →" links on each sub-signal if those detail pages exist

Data for all three is already computed in state — no new calculations needed.

---

## Constraints

- **Read `docs/UX_PATTERNS.md` before writing any HTML/CSS** (CLAUDE.md requirement)
- No new colours — use existing CSS vars (`--c-accent`, `--c-muted`, `--c-black`, `--c-border`)
- No emoji in body copy or buttons
- Navigation: tapping a ring navigates forward; back button returns to home
- Overlays must use `flex items-center justify-center` if any modal is involved
- Update `docs/CHANGELOG.md` and `docs/FEATURES.md` after changes

---

## Do Not Change

- The ring rendering logic itself (score → colour → arc) — just rearrange layout
- The CTA button ("Take it lighter today") — keep as-is, same position below the three rings
- Strain and Sleep detail pages — no changes needed there
- Any calculation or state — this is purely a layout/navigation change
