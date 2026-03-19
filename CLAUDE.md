# Mosaic Training Simulator

Adaptive marathon training plan simulator (TypeScript + Vite + Tailwind + Capacitor).

## Key Docs (read before making changes)

| Doc | What it contains |
|-----|-----------------|
| `docs/ARCHITECTURE.md` | Module map, data flows, key types, state abbreviations, subsystem notes |
| `docs/FEATURES.md` | Every feature in plain English — what it does, key file, test status |
| `docs/CHANGELOG.md` | Session-by-session history of significant changes |

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

## Conventions

- State abbreviations: `s.rw` (runs/week), `s.gs` (gym sessions), `s.v` (VDOT), `s.w` (current week), `s.typ` (runner type) — full table in ARCHITECTURE.md
- Path alias: `@/*` maps to `src/*`
- UI: Tailwind utility classes, vanilla DOM manipulation (no framework)
- Workouts: `Workout.t` is a free string type field, not an enum
- **Units**: All distances display via `formatKm(km, unitPref)`, all paces via `formatPace(secPerKm, unitPref)` or `fp()`, all workout descriptions via `fmtDesc(desc, unitPref)`. Never hardcode `/km`, `km`, or `/mi` in user-facing strings — always read `s.unitPref ?? 'km'` from state.

## Quality: Cross-cutting changes

When fixing a bug or wiring a feature that touches **many call sites** (e.g. unit formatting, theming, a renamed field):

1. **Audit first**: Before writing any code, grep for every instance across the codebase. List them.
2. **Fix all sites in one pass**: Don't fix 6 of 9 and call it done. If a site is intentionally skipped (e.g. internal log), note why.
3. **Verify completeness**: After the fix, re-grep to confirm zero remaining hardcoded instances in user-facing code.
4. **Test the toggle/flag end-to-end**: If the feature has a user toggle (like km/mi), mentally walk through every screen the user can reach and confirm the toggle applies. Call out any screens you can't verify.
