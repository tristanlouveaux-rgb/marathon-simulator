# Mosaic Training Simulator

Adaptive marathon training plan simulator (TypeScript + Vite + Tailwind + Capacitor).

## Key Docs (read before making changes)

| Doc | What it contains |
|-----|-----------------|
| `docs/ARCHITECTURE.md` | Module map, data flows, key types, state abbreviations, subsystem notes |
| `docs/FEATURES.md` | Every feature in plain English — what it does, key file, test status |
| `docs/CHANGELOG.md` | Session-by-session history of significant changes |
| `docs/UX_PATTERNS.md` | Design reference — zone bars, area charts, drill-down sub-pages, colour rules, **overlay/modal positioning** |
| `docs/SCIENCE_LOG.md` | Scientific rationale for every model/formula — constants, derivations, limitations, literature references |

## Issue Tracking Workflow

- **`.claude/TL thoughts`** is Tristan's raw scratchpad — stream of consciousness notes, observations, and bug reports. Do not clean it up.
- **`docs/OPEN_ISSUES.md`** is the curated, triaged issue list. Claude reads TL thoughts and moves items here with a root cause diagnosis and priority label.
- Issues are numbered ISSUE-XX. When fixing an issue, mark it `✅ FIXED` in `docs/OPEN_ISSUES.md` with the fix summary.
- **An issue must NOT be marked fixed until**: (1) Tristan has confirmed the fix, and (2) it has been tested on device or in the app. Do not pre-emptively mark issues resolved based on code inspection alone.

## Doc Maintenance Rules (always follow these)

After **any** code change, update the relevant docs before finishing:

- **Added or changed a feature** → update the feature's section in `docs/FEATURES.md`
- **Fixed a bug or made a significant change** → add a bullet to the current date section in `docs/CHANGELOG.md` (create the date heading if it doesn't exist)
- **Changed module structure, data flow, or key types** → update `docs/ARCHITECTURE.md`
- **Test status changed** (new tests added, tests fixed) → update ✅/⚠️/❌ in `docs/FEATURES.md`

Do **not** wait to be asked. Keeping these docs current is part of every task.

## Commands

- **Typecheck**: `npx tsc --noEmit`
- **Test**: `npx vitest run` (single run) / `npx vitest` (watch)
- **Dev server**: `npx vite`
- **Build**: `npx tsc && npx vite build`

## Tracking vs Planning — Keep Them Separate

Mosaic is a tracking app *and* a planning app, and the two must not be conflated:

- **Tracking** answers "what did the user do, and what is it telling us about their fitness?" — activity matching, race prediction, adherence scoring, historical analysis. Here we *describe* reality.
- **Planning** answers "what should the user do next?" — plan engine, replace-and-reduce, workout generation, load targets. Here we *prescribe*.

A fact used in tracking does not automatically apply to planning. Example: the 5–11% bike-to-run pace discount in triathlon is a race-time prediction input (tracking), not a training-load discount on brick runs (planning — the training stimulus is full because the athlete's effort was maximal). When writing a new calculation, state explicitly which side of this line it sits on.

## No Made-Up Numbers or Logic

**Never invent constants, multipliers, thresholds, or fallback values.** If the right number is not already in the codebase or explicitly provided by Tristan, stop and ask. This applies to:

- Phase multipliers (e.g. build = 1.08x, taper ramp 0.85→0.55)
- Fallback estimates (e.g. "baseline = 40 km if no history")
- Scoring weights, decay rates, tier thresholds, TSS conversion factors

If you find yourself writing a number that isn't sourced from existing code or state, ask Tristan what it should be before writing it.

## Scientific Defensibility

Every model, formula, or algorithm that drives a user-facing number must be scientifically defensible. When building or modifying any calculation:

1. **State the science**: Before implementing, explain the physiological or statistical basis. Name the model (e.g. Banister impulse-response, EPOC decay) or cite the principle.
2. **Justify every constant**: If a number is derived from literature, say which. If empirically calibrated, say against what. If it's a pragmatic shortcut, say why it's acceptable.
3. **Log the rationale**: After implementing, add an entry to `docs/SCIENCE_LOG.md` with the formula, what each term means, why it's defensible, and what the known limitations are.
4. **Flag what's weak**: Every model has assumptions. Call them out explicitly (e.g. "linear scaling is a simplification of bi-exponential EPOC decay").

`docs/SCIENCE_LOG.md` is the permanent record. Future sessions must check it before modifying any model to understand why decisions were made.

## Conventions

- State abbreviations: `s.rw` (runs/week), `s.gs` (gym sessions), `s.v` (VDOT), `s.w` (current week), `s.typ` (runner type) — full table in ARCHITECTURE.md
- Path alias: `@/*` maps to `src/*`
- UI: Tailwind utility classes, vanilla DOM manipulation (no framework)
- Workouts: `Workout.t` is a free string type field, not an enum
- **Units**: All distances display via `formatKm(km, unitPref)`, all paces via `formatPace(secPerKm, unitPref)` or `fp()`, all workout descriptions via `fmtDesc(desc, unitPref)`. Never hardcode `/km`, `km`, or `/mi` in user-facing strings — always read `s.unitPref ?? 'km'` from state.

## UI Pre-flight (required before writing any UI code)

Before writing a single line of HTML or CSS, state out loud in your response:

1. **UX_PATTERNS read** — confirm you have read `docs/UX_PATTERNS.md` in this session
2. **Copy rules read** — confirm you have read the "UI Copy" sections in this file
3. **Existing pattern found** — name the existing component you are modelling (e.g. "`buildInjuryBanner` for the banner structure, `openCheckinOverlay` for the modal")
4. **Visual constraints checked** — confirm the change uses ≤ 2 non-neutral colours, adds no decorative icons, adds no tinted card backgrounds, adds no decorative gradients, uses no ALL-CAPS data labels

If you cannot confirm all four, read `docs/UX_PATTERNS.md → Visual Constraints` first. Do not skip this step under time pressure.

## UI Component Rules

Before building any new chart, bar, or data visualisation: **read `docs/UX_PATTERNS.md`**. It defines the canonical patterns for zone bars, area charts, drill-down sub-pages, colour spectrums, empty states, and **overlay/modal positioning**.

**Overlays must always be vertically centered** (`flex items-center justify-center`). Never use `items-end` (bottom sheet) — it appears off-screen on desktop and behind the keyboard on iOS. See `docs/UX_PATTERNS.md → Overlays and Modals` for the canonical HTML pattern.

## Git Safety — Protecting Uncommitted Work

**NEVER run `git checkout -- <file>` to undo your own changes.** This destroys ALL uncommitted work on that file — not just what you added. The user's in-progress work is unrecoverable.

**The correct way to undo your own edits:**
1. Use the Edit tool to manually reverse your specific changes.
2. If unsure what you changed: `git diff <file>` first.
3. `git checkout -- <file>` is only safe if `git diff <file>` shows ONLY your own changes and nothing else.

**When in doubt: use Edit to undo, not git.**

## Navigation Rules

- **Modals close back to the view that opened them** — never navigate to Home as a side-effect of dismissing a modal. `renderHomeView()` should not appear in modal close/CTA handlers unless the modal was opened from Home.
- **Exception — forward-navigation CTAs**: Some modals have a CTA that is a deliberate step forward (e.g. the week debrief "Continue →" logically lands on Plan so the user sees their new week). These navigate to the contextually correct view, not necessarily the opener.
- **Circular import rule**: `plan-view.ts` imports `week-debrief.ts`. Any file already imported by `plan-view.ts` must NOT statically import `plan-view.ts` — use a dynamic import (`import('@/ui/plan-view').then(...)`) instead.

## UI Copy — Writing Style

All user-facing copy should read like a knowledgeable consultant, not a wellness app.

**Principles:**
- **Direct and factual.** Lead with the point. No preamble.
- **No motivational padding.** Cut phrases like "your body needs", "you're doing great", "fitness is built in recovery, not in training". State the fact instead.
- **Concrete over abstract.** "Volume drops 30–50%" beats "you'll be doing less". Numbers earn trust.
- **No emoji in body copy.** Emoji are permitted in workout type badges or status icons only.
- **Avoid second-person where the data speaks for itself.** "Sleep or HRV indicates incomplete recovery" not "your body hasn't fully recovered".
- **Short sentences. Active voice.** Each sentence carries one idea.
- **No em dashes (—) ever.** Rewrite the sentence instead. Use a period, comma, or "to" (e.g. "2 to 3 weeks" not "2–3 weeks" in prose). En-dashes in numeric ranges (e.g. "150–350 TSS") are fine.

**Reference examples (load-taper view):**

> Aerobic development at easy effort. High proportion of Zone 2 running. Load is moderate and consistent — the aim is to raise your aerobic ceiling before intensity is introduced.

> Volume drops 30–50% while intensity is maintained. The goal is to clear accumulated fatigue before race day. Fitness does not decline over a 2–3 week taper — it consolidates.

> Training creates fatigue that sits on top of fitness. During taper, fatigue clears while fitness remains elevated.

**Anti-patterns to avoid:**

| ❌ AI/wellness tone | ✅ Consultant tone |
|---|---|
| Your body needs more rest today | Sleep or HRV indicates incomplete recovery |
| Pushing hard risks accumulating fatigue | Hard sessions on poor sleep raise injury risk and blunt the stimulus |
| Fitness is built in recovery, not in training | Hard sessions only drive adaptation when recovery is adequate |
| One missed day rarely matters | A single missed day has no meaningful impact on fitness |
| You still get the aerobic stimulus | Aerobic stimulus without the additional stress |

## UI — No Colour on Navigation Links

**Never use `var(--c-accent)` on secondary navigation text buttons.** This includes "Learn more →", "Breakdown →", "View →", and any drill-down or info link. These are `var(--c-muted)`, no border, no colour.

`var(--c-accent)` is reserved for form-submission CTAs only ("Save", "Confirm"). Do not use it for in-page action buttons, suggestions, or readiness nudges — these should use `background:transparent` with `border:1px solid var(--c-border)` and `color:var(--c-black)`.

**Do not default to blue.** When in doubt, use a bordered pill with no fill.

## UI Copy — No Emoji in Buttons or Body Copy

**Never use emoji in buttons, header actions, or body copy.** This includes injury/status buttons (no 🩹, ❤️, 💪, etc.).

- Emoji are only permitted in workout type badges or status icons where they are the primary visual element with no alternative
- All header action buttons must use SVG icons or plain text labels
- The check-in system uses plain text labels only — no icons in the button

## Quality: Cross-cutting changes

When fixing a bug or wiring a feature that touches **many call sites** (e.g. unit formatting, theming, a renamed field):

1. **Audit first**: Before writing any code, grep for every instance across the codebase. List them.
2. **Fix all sites in one pass**: Don't fix 6 of 9 and call it done. If a site is intentionally skipped (e.g. internal log), note why.
3. **Verify completeness**: After the fix, re-grep to confirm zero remaining hardcoded instances in user-facing code.
4. **Test the toggle/flag end-to-end**: If the feature has a user toggle (like km/mi), mentally walk through every screen the user can reach and confirm the toggle applies. Call out any screens you can't verify.
