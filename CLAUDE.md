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
| `docs/WEBHOOKS.md` | Garmin webhook reference — every payload type, DB targets, production verification requirements, debugging checklist |

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

## Multiple dev tabs do not share state

When `npx vite` is running on more than one port (e.g. localhost:5173 and localhost:5175), each tab is a separate browser origin with its own `localStorage`, its own Garmin/Apple physiology sync state, and its own `s.vo2` / `s.maxHR` / `s.pbs`. The same code can produce different LT / VDOT / pace numbers across two tabs simply because one has physio synced and the other hasn't. Don't chase this as a code bug. When debugging cross-tab divergence, first confirm which physiology fields are populated in each tab — the diagnostic logs in `review.ts` and `stats-view.ts` print these.

## Test Failure Policy

Never declare a test failure "pre-existing" without explaining in one sentence exactly why it is safe to ignore. If you cannot explain it in one sentence, investigate it — pre-existing failures are often real model regressions, stale test expectations from an undocumented code change, or tests you broke yourself without realising. "It was already failing" is not an explanation.

## Console snippets: grep before you guess, chain `?.` after parse

When suggesting a one-liner for the browser console (to inspect state, localStorage, IndexedDB, etc.), two failure modes cost a round-trip every time:

1. **Wrong key name.** Don't guess. The localStorage key is `marathonSimulatorState` (defined as `STATE_KEY` in `src/state/persistence.ts`). If a future snippet needs a different key/constant, grep for the literal in the codebase first — `localStorage.setItem` / `localStorage.getItem` / DB names — rather than picking something that "sounds right". Saves a "Cannot read properties of null" round-trip every time.

2. **`JSON.parse(null)` returns `null`, not throws.** `localStorage.getItem` on a missing key returns `null`; piping that through `JSON.parse` returns `null`; then `.onboarding` on null throws and looks like a real bug. Always parenthesise the parse and chain `?.` afterwards so a wrong key prints `undefined` instead of crashing:

   ```js
   // Bad — throws if the key is missing or wrong
   JSON.parse(localStorage.getItem('foo')).onboarding?.x

   // Good — prints undefined and tells you the key/path was wrong
   JSON.parse(localStorage.getItem('foo') ?? 'null')?.onboarding?.x
   ```

The same applies to `sessionStorage`, `IDBDatabase` lookups, and any chain that starts from a possibly-null source.

## Supabase dashboard has a built-in AI

When asking the user to diagnose edge function / DB issues, remember the Supabase dashboard offers an AI assistant that can read logs, traces and schema directly. It needs an `execution_id` to pull the stack trace for a specific 500 — so guide the user to click the failing invocation row first, grab the execution_id, and paste it into the Supabase AI prompt. Faster than asking the user to transcribe stack traces manually.

## Strava is the Canonical Activity Source

**Garmin webhook data is a fallback only.** If a Strava row exists for the same activity, the Strava row must always win — it carries HR zones, iTRIMP, polyline, elevation, and km splits that the Garmin webhook summary never provides.

- `sync-activities` suppresses any Garmin row whose start time is within ±10 min of a Strava row.
- `matchAndAutoComplete` upgrades already-matched Garmin actuals to Strava when the Strava row arrives later (same ±10 min window).
- The UI shows the source badge as "Strava" vs "Garmin" via `garminId.startsWith('strava-')`. If a user reports seeing "Garmin" for a recent run that was tracked on Strava, check whether the Strava backfill ran and whether the upgrade loop fired.
- **Never intentionally store or display Garmin-sourced data when Strava data exists for the same activity.**

## Tracking vs Planning — Keep Them Separate

Mosaic is a tracking app *and* a planning app, and the two must not be conflated:

- **Tracking** answers "what did the user do, and what is it telling us about their fitness?" — activity matching, race prediction, adherence scoring, historical analysis. Here we *describe* reality.
- **Planning** answers "what should the user do next?" — plan engine, replace-and-reduce, workout generation, load targets. Here we *prescribe*.

A fact used in tracking does not automatically apply to planning. Example: the 5–11% bike-to-run pace discount in triathlon is a race-time prediction input (tracking), not a training-load discount on brick runs (planning — the training stimulus is full because the athlete's effort was maximal). When writing a new calculation, state explicitly which side of this line it sits on.

## Manually-set Benchmarks Yield to Improvements

**Any user-entered benchmark (FTP, CSS, LT, PBs, etc.) is overridden when an auto-derived value clearly improves on it.** A user's manually-entered number is a snapshot, not a permanent ceiling — if their actual training shows a better value with sufficient confidence, the system updates it.

Rules for every benchmark with a `*Source: 'user' | 'derived'` provenance field:

- **Direction of improvement** must be explicit per metric (FTP higher = better, CSS sec/100m lower = better, VDOT higher = better, race PB time lower = better).
- **Confidence floor**: only override `'user'` values when the derived estimate has at least `'medium'` confidence (or the equivalent per-estimator quality gate). Never let a `'low'` or `'none'` estimate clobber a user value.
- **Flip provenance to `'derived'`** when the override fires, so the next run keeps refreshing it. Log a one-line `console.log` so the change is visible.
- **Surface the change in UI**: the caption changes from "Set manually." to "Updated from your rides/swims/runs — beat your last test." Don't silently swap the number.

`main.ts` is the canonical place for this refresh on launch. Add the same pattern wherever a new auto-derived benchmark gets wired up.

## Build target — single-user dev → broader iOS ship

Mosaic is currently single-user (Tristan) but the goal is to ship as an iOS app to broader users. State migrations are not required yet because the user base resets cleanly, but **new state fields should always be optional (`?:`)** so fresh installs work without migration scaffolding. Schema-version bumps in `state.ts` (`STATE_SCHEMA_VERSION`) are reserved for genuine breaking changes.

## Mirror rule — running and triathlon mode parity

Running and triathlon mode logic should mirror each other where applicable. When changing one mode's adaptation, prediction, or workout-progression behaviour, **explicitly evaluate the other** before committing.

**Things that ARE mirrored:**
- Per-session effort scoring (HR effort, pace adherence, RPE-vs-expected)
- Weekly duration progression via `effortMultiplier` (running uses it; tri now mirrors via `triEffortMultiplier`)
- Marker auto-refresh from history (VDOT for run; CSS / FTP for tri)
- Race-outcome logging (predicted vs actual after a target race)
- Skip-handler push/drop rule
- Suggestion-modal acceptance contract (user accepts before plan mutates)

**Things that ARE intentionally different** (don't try to merge):
- Tri has per-discipline CTL/ATL/Form (running has a single combined number — single discipline)
- Tri has course factors and durability cap (running's predictor doesn't model these — single-discipline race, simpler course shape)
- Tri prediction uses `blendPredictions` per leg at the leg's actual distance; running uses it once at race distance

When in doubt, search both `*.ts` and `*.triathlon.ts` for the same concept and bring them into parity.

## Adaptation transparency — surface meaningful changes, don't spam

When the system makes a non-trivial change to the plan or the prediction, **the user should know about it**. Bundle changes into the end-of-week summary where possible. Mid-cycle changes that can't wait (a marker auto-bump from a fresh test, a race outcome) get their own targeted note.

**Rules of thumb:**
- **Big changes** (week-rollover effects, end-of-week recap, race outcome) → modal or full summary
- **Small but meaningful changes** (marker auto-bump, adaptation-ratio crossing ±5%) → small toast/note
- **Don't pop** for things the user can passively read on their next visit (course factors at race-pick, individual activity matched, plan re-rendered after version bump)

**Meaningful-change thresholds** (Tristan, 2026-04-30):
- FTP: ≥ 5 W delta (`MARKER_BUMP_THRESHOLD_FTP_W`)
- CSS: ≥ 5 sec/100m delta (`MARKER_BUMP_THRESHOLD_CSS_SEC`)
- VDOT: ≥ 1 point delta (`MARKER_BUMP_THRESHOLD_VDOT`)

**Notify-once architecture**: store last-notified marker values on state (`triConfig.notifiedMarkers`); compare current vs last-notified at every trigger; surface only if delta crosses threshold; update the last-notified field after surfacing so we don't spam every launch.

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

**NEVER run `git stash` for diagnostic or testing purposes** ("let me stash to see if these errors are pre-existing"). `git stash` removes work from the working tree and a subsequent `git stash pop` can fail with merge conflicts that block recovery. **Real incident, 2026-04-30**: an agent stashed ~17,000 lines of WIP to test an unrelated typecheck question; pop failed because parallel agents kept editing tracked files; recovery took 30 minutes and required dumping the stash to a /tmp patch file as a safety net.

**To answer "is this error pre-existing?" without stashing**:
- `git diff <file>` — see your own changes
- `git show HEAD:<file>` — see the committed version of a single file
- `git diff HEAD -- <file>` — full diff of one file vs HEAD
- Create a temp branch: `git switch -c temp/diagnostic` (preserves working tree, can switch back)

**The correct way to undo your own edits:**
1. Use the Edit tool to manually reverse your specific changes.
2. If unsure what you changed: `git diff <file>` first.
3. `git checkout -- <file>` is only safe if `git diff <file>` shows ONLY your own changes and nothing else.

**Before any destructive git operation** (stash, reset, clean, checkout-discard): dump the current working tree to a /tmp patch file first. `git diff > /tmp/recovery.patch` is a 1-second insurance policy that has saved at least one session.

**When in doubt: use Edit to undo, not git.**

## Working posture — things Tristan has explicitly endorsed

These are agent-behaviour preferences that have produced good outcomes on this project. They're not absolute rules but defaults — deviate consciously, not by reflex.

**Push back when you disagree, accept when you're corrected.** Tristan reads agreement-by-default as sycophancy and corrects against it. If you think the user is wrong about something technical (a number, a model, an architectural call), say so once with reasoning and propose an alternative. Equally, when corrected, accept the correction without contortion — don't half-defend your previous position. Real session example (2026-04-30): user said "PBs are a ceiling", agent agreed, user pushed back ("PBs aren't a ceiling either"), agent dropped the framing entirely and rebuilt around the better model. That round-trip is fine; pretending the earlier framing was right is not.

**Probe before any bundle larger than ~1 hour.** Use `AskUserQuestion` at architectural fork points — scope, format, primary signal, where output lives. The cost of a 30-second clarifying question is far below the cost of building the wrong thing for two hours. Good fork-point questions: "modal vs toast vs inline?", "auto-apply vs surface-as-suggestion?", "running pattern or new shape?". Bad ones: micro-decisions the user won't care about (variable names, exact button text, file structure).

**Validate what's shipped before building more.** When asked "what's next", the honest answer is sometimes "use what we built before adding". After several feature-heavy sessions, propose dogfooding as a real next step. Resist the build-more reflex when the existing surface hasn't been exercised against real data. Captured as ISSUE-152 (2026-04-30) — the "process item" pattern.

**Cite file:line whenever pointing at code.** Every reference to a function, type, or constant carries `path/to/file.ts:linenumber`. The user can navigate directly. Saves both of you from re-finding things across sessions.

**For UI work: read UX_PATTERNS, name the existing pattern, ship.** The UI Pre-flight section above is load-bearing — the four-item check (UX_PATTERNS read / Copy rules read / existing pattern named / visual constraints checked) catches most one-off design drift before it ships. Don't skip it under time pressure.

## Multi-agent awareness — your edits may collide

If multiple Claude agents are running concurrently against the same repo, your edits to **shared / canonical files** can be overwritten by another agent's parallel work. Affected files include `CLAUDE.md`, `src/types/state.ts`, `src/types/triathlon.ts`, `src/constants/triathlon-constants.ts`, top-level docs, and any high-level integration file. **Real incident, 2026-04-30**: edits to `CLAUDE.md` and `triathlon.ts` were rolled back three times in a row by parallel agent activity before the issue was identified.

**Signals you should respect:**
- An edit you just made appears reverted on the next read → STOP, run `git diff <file>` to see current state, do not blindly re-apply.
- A `system-reminder` says the file was "modified externally" → another agent or a linter/formatter has touched it, treat your previous knowledge of the file as stale.
- Two `Edit` retries fail in a row with file-changed errors → don't try a third time. Read the current file, understand why it differs, then decide.

**When you must edit a shared file**: dump it to a /tmp patch first (`git diff <file> > /tmp/<file>.before.patch`). If your edit gets reverted, the patch is your re-apply path. Don't hammer Edit retries.

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

## Quality: Two numbers that mean the same thing must come from the same source

If a card and its drill-down (or any two surfaces) display the same metric, they must read from a single canonical computation. Never recompute "the same thing" with a different argument list — archived plans, seeds, or fallback paths almost always diverge between sites and produce numbers that disagree.

**The rule**: when a value appears in more than one place, find or create a canonical helper (e.g. `computeReadinessACWR`) and call it from every surface. The drill-down's headline number, its sub-bars, and the parent card must all come from the *same call*.

Audit checklist when adding or modifying any metric display:
- Grep for every place the metric is shown.
- Confirm they all read from the same function with the same arguments.
- If a drill-down recomputes the metric "for more detail", that detail must be derived from the canonical result, not a parallel computation.

## Quality: Cross-cutting changes

When fixing a bug or wiring a feature that touches **many call sites** (e.g. unit formatting, theming, a renamed field):

1. **Audit first**: Before writing any code, grep for every instance across the codebase. List them.
2. **Fix all sites in one pass**: Don't fix 6 of 9 and call it done. If a site is intentionally skipped (e.g. internal log), note why.
3. **Verify completeness**: After the fix, re-grep to confirm zero remaining hardcoded instances in user-facing code.
4. **Test the toggle/flag end-to-end**: If the feature has a user toggle (like km/mi), mentally walk through every screen the user can reach and confirm the toggle applies. Call out any screens you can't verify.
