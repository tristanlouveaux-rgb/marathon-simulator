# Mosaic Training Simulator

Adaptive marathon training plan simulator (TypeScript + Vite + Tailwind + Capacitor).

## Key Docs (read before making changes)

| Doc | What it contains |
|-----|-----------------|
| `docs/ARCHITECTURE.md` | Module map, data flows, key types, state abbreviations, subsystem notes |
| `docs/FEATURES.md` | Every feature in plain English — what it does, key file, test status |
| `docs/CHANGELOG.md` | Session-by-session history of significant changes |

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
