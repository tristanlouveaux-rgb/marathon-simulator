# Onboarding Overhaul — Working Plan

> Living doc. Updated as decisions are locked and screens are built. Started 2026-04-17.

## Status

**Current step**: Page 2 (Training Goal) built. Next: audit Strava auth flow for Page 3.
**Last updated**: 2026-04-17

---

## Locked decisions

1. **Triathlon** = "Coming soon" stub. Tile visible but non-clickable with a subtle badge. Research in [`docs/TRIATHLON.md`](TRIATHLON.md), not built.
2. **Strava** = primary data pull. Garmin/Apple Health deferred.
3. **Imagery** = editorial B&W. Action-in-motion, not posed. Reference mood: Tracksmith, On, District Vision.
4. **Top banner on page 2** ("This takes a little longer...") = **killed**.
5. **"Return to plan"** button during initial onboarding = **killed**. Only shows when re-editing from within the app.
6. **Target flow length**: 7 steps. Down from current ~16.
7. **Button style**: every onboarding CTA and the Back button use `.m-btn-glass` (see `docs/UX_PATTERNS.md → Glass button`). The Strava-orange brand CTA on page 3 is the only permitted exception. Future screens default to glass — do not re-implement inline button styles.
8. **Mode tiles**: Running / Hyrox (coming soon) / Triathlon (coming soon) / Tracking (log-only, being built in parallel). Fitness is **not** its own mode — it lives inside Running as the "No event" branch (we ask "Training for an event?" Yes/No after Running is picked). Keeps the tile grid focused on sports, and keeps all running-based intent under one roof.

---

## Proposed flow (7 steps)

| # | Screen | File | Purpose | Skippable? |
|---|--------|------|---------|------------|
| 1 | **Welcome** | `welcome.ts` | Name + intent | No |
| 2 | **Training Goal** | `training-goal.ts` | Mode selection: Running / Hyrox / Triathlon (coming soon) / Fitness | No |
| 3 | **Connect Strava** | TBD (repurpose `strava-history.ts`?) | Pull real training data | **Yes** — falls back to manual |
| 4 | **"Here's what we know about you"** | new | Show pulled data, inline-editable | No |
| 5 | **Race or target** | conditional:<br>• Running → `event-selection.ts`<br>• Hyrox → new<br>• Fitness → new | Goal + date | Depends on mode |
| 6 | **Schedule** | `frequency.ts` (redesign) | Days/week + cross-training | No |
| 7 | **Plan preview** | `plan-preview.ts` | Show generated plan, confirm | No |

---

## What gets dropped (or moved)

| Current step | Fate | Why |
|--------------|------|-----|
| `background.ts` (experience level) | **Inferred** from Strava volume + pace | "Returning athlete" / "Novice" is derivable |
| `volume.ts` | **Inferred** | Weekly km from synced runs |
| `pbs.ts` / `performance.ts` | **Inferred** from Strava `best_efforts` | Per screen 4 editable |
| `fitness.ts` / `fitness-data.ts` | **Inferred** | VDOT/LT from recent hard efforts |
| `physiology.ts` (HRV, RHR) | **Moved to Account settings** | Not plan-generation-critical; pulled from Garmin post-launch |
| `commute.ts` (run-to-work) | **Moved to Account settings** | Lifestyle refinement, not a mandatory onboarding input |
| `runner-type.ts` | **Computed**, shown on page 4 | Editable on review screen if wrong |
| `assessment.ts` | **Folded into page 4** | — |
| `activities.ts` (recurring sports) | Fold into **page 6 (Schedule)** | — |

### Manual fallback (Strava skipped)

If user skips Strava on page 3, page 4 becomes a compressed manual-entry screen: experience level, PBs, volume. One longer screen, not 4 separate steps. Escape hatch — still usable, just less magical.

---

## Per-screen detail

### Page 1 — Welcome ✅ DONE

Copy, depth, trust row locked as of 2026-04-17. See CHANGELOG entries.

### Page 2 — Training Goal ✅ DONE

**Layout**: 4 vertical stacked full-bleed tiles. Full-bleed photo, dark bottom gradient, label + 1-line sub.

**Options**:
- **Running** — "5k to marathon, trail, ultra"
- **Hyrox** — "Hybrid racing: run + functional"
- **Triathlon** — "Coming soon" (non-clickable, subtle badge)
- **Fitness** — "Build endurance, strength, daily vitality"

**Selected state**: white ring + check chip top-right. Slight scale.

**Chrome to remove**: top banner ("This takes a little longer..."), "Return to plan" link.

**Chrome to keep**: progress dots (smaller, muted), "Back" (bottom-left), "Continue" (disabled until pick).

**Imagery**: editorial B&W, action-in-motion. Nano banana prompts:
- Running — mid-stride runner on open road, grainy B&W, shot from behind/side, overcast
- Hyrox — athlete mid-burpee or sled push, grainy B&W, indoor
- Triathlon — swimmer mid-stroke or T1 bike rack, grainy B&W (still generate, even though tile is disabled — placeholder for v2)
- Fitness — figure mid-deadlift or rowing, grainy B&W, editorial

**Open questions**: none. Build.

### Page 3 — Connect Strava (next)

**Open questions**:
- What does `strava-history.ts` do today? Audit before designing.
- Returning users already signed in → skip screen or confirm?
- Visual: Strava-orange CTA (permitted since it's the only non-neutral on the screen) or monochrome?

### Page 4 — Here's what we know about you (magic moment)

**The most important screen in the flow.** Earns the "Built from your existing training" claim on page 1.

**Shows**:
- Weekly volume (last 4 weeks average)
- 10k / half / marathon PBs with **source activity + date** per row ("3:12 · Berlin Marathon, Oct 2024")
- VDOT estimate
- HRV baseline (if Garmin connected)
- Computed runner-type label ("Returning Athlete")
- Recent race / hard effort

**Open questions**:
- Single scrollable card or multiple small cards? (Lean: single column of editable rows)
- What if Strava returned <4 weeks data? (Empty-state design needed)
- Editable rows — inline edit, or tap-to-edit sheet per row?

### Page 5 — Race / target (conditional)

**Running**: audit `event-selection.ts`. Keep if still good, redesign for consistency if not.
**Hyrox**: new. Target date + singles/doubles/mixed + venue (optional).
**Fitness**: new. Focus picker (lose weight / build endurance / get faster / general) + optional target date.

### Page 6 — Schedule (redesign)

Merge current `frequency.ts` + `activities.ts` (recurring sports). One screen: days/week + "what else do you do regularly" multi-select with frequency pickers.

### Page 7 — Plan preview ✅ (audit later)

Exists. Audit before launch for visual consistency.

---

## Build order

- [x] **Page 1 (Welcome)** — copy, depth, trust row
- [x] **Page 3 prerequisite — Background step** (experience pills depth) — done in earlier pass, will likely be deleted when page 4 ships, but doesn't block
- [x] **Page 2 (Training Goal)** — 4 mode tiles (Running/Fitness live, Hyrox/Triathlon coming-soon), segmented CTA with dent, banner killed. Editorial B&W imagery = dark gradient placeholder; swap `ModeTile.bg` to `background-image: url(...)` when nano banana assets land
- [x] **Audit Strava auth flow** — confirmed working end-to-end 2026-04-23
- [x] **Page 4 (Review)** — magic-moment screen shipped 2026-04-18 (`src/ui/wizard/steps/review.ts`). Single column of inline-editable rows. Silently diverts to manual-entry if fewer than 12 running activities / no volume / no PBs.
- [x] **Page 7 (Plan preview)** — `plan-preview-v2.ts` drafted 2026-04-18 as visual-consistency rewrite of legacy `plan-preview.ts`. Not yet swapped in.
- [x] **Page 3 (Connect Strava)** — `connect-strava.ts` shipped 2026-04-18: Strava-orange CTA, muted "Enter manually" skip link, auto-skip when already connected, `skippedStrava` flag on state. Controller rewire pending.
- [x] **Page 5 (Race/target)** — `race-target.ts` drafted 2026-04-18 (running + fitness paths, hyrox/triathlon auto-skip). Not yet wired into controller.
- [x] **Page 6 (Schedule)** — `schedule.ts` drafted 2026-04-18 (runs/gym/recurring-activities merged). Not yet wired into controller.
- [x] **Controller rewire** — STEP_ORDER wired to new flow, mode branching in place, renderer dispatches all new screens (2026-04-23)
- [x] **Account settings** — physiology already lives on Account via existing gender/PB/Edit Profile rows + wearable sync. No separate screen needed. Onboarding `physiology` step removed from flow 2026-04-24.
- [x] **Manual-entry fallback** — compressed version of page 4 for users who skip Strava (`src/ui/wizard/steps/manual-entry.ts`, 2026-04-18). Not yet wired into controller — step ordering pass pending.

---

## Changelog

- **2026-04-24** — Legacy wizard cleanup. Deleted 15 unused step files (`activities`, `assessment`, `background`, `commute`, `event-selection`, `fitness-data`, `fitness`, `frequency`, `pbs`, `performance`, `physiology`, `plan-preview`, `strava-history`, `training-goal`, `volume`). Pruned `OnboardingStep` union to active steps only. Removed `physiology` from `STEP_ORDER`. Account's "Edit Profile" button now jumps to `review` (PBs + volume editor). Added migration guard in `initWizard` that bumps persisted state on deleted steps to `goals`.
- **2026-04-23** — Running/Hyrox/Triathlon/Just-Track tile photos swapped from 9 MB PNGs to 1400-wide JPEGs (~350 KB each). Grain overlay + `contrast(1.05)` filter dropped. `image-rendering: -webkit-optimize-contrast` added. Render is crisper and load is 25× smaller.
- **2026-04-17** — Plan drafted. Page 1 already shipped (three iterations, landed on open layout + stronger copy + one-line trust row). Page 2 next.
- **2026-04-18** — Running photo dropped into Page 2 Running tile (`src/assets/onboarding/running.png`, anchored `60% 20%` under the tile's grayscale filter). Pages 1–3 + manual-entry fallback unified on `.m-btn-glass`: welcome "Build my plan", goals segmented CTA collapsed to a single glass pill with inline arrow, manual-entry "Continue", and the shared Back button. Strava-orange CTA retained as the locked branded exception.
- **2026-04-18** — Manual-entry fallback built (`manual-entry.ts`). Single screen: experience pills + 4 PB rows + weekly-volume input (unit-aware, writes to `state.detectedWeeklyKm`). All fields optional. Not yet wired into the wizard controller — Tristan will handle step ordering.
- **2026-04-17** — Page 2 shipped. 4 vertical full-bleed mode tiles (Running, Hyrox, Triathlon, Fitness). Hyrox + Triathlon gated behind "Coming soon" badge (non-clickable, muted). Running & Fitness live — `trainingMode` field added to `OnboardingState`, legacy `trainingForEvent` auto-patched for backwards compat. Detail picker (distance/focus/event) preserved below the tile row so plan generation stays intact until Page 5 ships. Segmented CTA (label pill + arrow chip) with `:active` dent. Top banner ("This takes a little longer...") killed from `renderer.ts`.
