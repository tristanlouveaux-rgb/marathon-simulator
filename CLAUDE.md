# Mosaic Training Simulator

Adaptive marathon training plan simulator (TypeScript + Vite + Tailwind + Capacitor).

**Read `docs/ARCHITECTURE.md` before making changes** — it has the module map, data flows, key types, and state abbreviation lookup.

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
