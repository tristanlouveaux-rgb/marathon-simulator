# Mosaic Runbook

Operational reference. Read on-demand when the situation matches — not part of the always-loaded ruleset.

---

## Background snapshots — work is auto-saved every 5 minutes

A launchd job (`run.mosaic.snapshot`, plist at `~/Library/LaunchAgents/run.mosaic.snapshot.plist`) runs `scripts/snapshot.sh` every 5 minutes. Each run writes a commit object containing the **entire working tree** (tracked + untracked, respecting `.gitignore`) to `refs/snapshots/auto-<UTC-timestamp>`. The script uses a temporary git index so the real index and working tree are **never touched** — safe to run while edits are in progress, including under parallel agents.

Retention: keeps the 24 newest snapshots; older ones are pruned after 7 days. Snapshot refs are local-only (under `refs/snapshots/`, not `refs/heads/`) so they never push to GitHub.

**If work goes missing — recovery runbook:**

```bash
# 1. List snapshots, newest first, with diff size vs current HEAD
scripts/snapshot-list.sh

# 2. See exactly what's in one of them
scripts/snapshot-list.sh auto-20260519-1430        # full diff vs HEAD
git show refs/snapshots/auto-20260519-1430 --stat  # file list only

# 3. Restore one file from a snapshot
git checkout refs/snapshots/auto-20260519-1430 -- path/to/file.ts

# 4. Restore everything from a snapshot (nukes current working tree — confirm with user first)
git checkout refs/snapshots/auto-20260519-1430 -- .

# 5. Or pull the snapshot in as a branch and cherry-pick from it
git branch recover/from-snapshot refs/snapshots/auto-20260519-1430
```

**Operational notes:**
- Worker log: `.git/snapshots/snapshot.log`. Launchd stdout/stderr: `.git/snapshots/launchd.{out,err}.log`.
- The job is idempotent and skips when the working tree is clean.
- If snapshots ever stop running: `launchctl list | grep mosaic.snapshot` should show the job; `launchctl unload && launchctl load ~/Library/LaunchAgents/run.mosaic.snapshot.plist` to restart.
- Snapshot refs are **not** a substitute for real commits — they're a 5-minute safety net against crashes, accidental `git checkout --`, parallel-agent clobbers, and stash-pop failures. Keep committing real WIP as normal.

---

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

---

## Multiple dev tabs do not share state

When `npx vite` is running on more than one port (e.g. localhost:5173 and localhost:5175), each tab is a separate browser origin with its own `localStorage`, its own Garmin/Apple physiology sync state, and its own `s.vo2` / `s.maxHR` / `s.pbs`. The same code can produce different LT / VDOT / pace numbers across two tabs simply because one has physio synced and the other hasn't. Don't chase this as a code bug. When debugging cross-tab divergence, first confirm which physiology fields are populated in each tab — the diagnostic logs in `review.ts` and `stats-view.ts` print these.

---

## Supabase dashboard has a built-in AI

When asking the user to diagnose edge function / DB issues, remember the Supabase dashboard offers an AI assistant that can read logs, traces and schema directly. It needs an `execution_id` to pull the stack trace for a specific 500 — so guide the user to click the failing invocation row first, grab the execution_id, and paste it into the Supabase AI prompt. Faster than asking the user to transcribe stack traces manually.

---

## Backgrounds stuttering / flashing / flickering on a page

Symptom: a page's background (rings, halo, waves) **stutters or "jumps about" on open**, or a glassy element **flickers** (e.g. the Readiness hero ring + its number flickered, 2026-05-27). These are two different faults with two different causes — identify which before fixing.

**First, separate the two:**
- **Stutter / jump / dropped frames during the entrance** = a per-frame *re-rasterization* problem (frame rate).
- **Flicker (rapid on/off of an element + its children)** = a *compositing* problem (`backdrop-filter`).

**Cause 1 — filter + transform animation (the stutter).** If an element has an SVG `feGaussianBlur`/drop-shadow filter *or* a CSS `filter: blur()` **and** it animates its transform (scale/translate — entrance bloom, drift, pulse, halo breathe, wave drift), the browser re-rasterizes the filtered region every frame → ~30fps with multi-100ms stalls. **Fix:** remove the filter from anything that animates its transform. Crisp holds 61fps and is visually identical at rest. CSS `filter` is *worse* than SVG filter, not better; `will-change` does not save it. All page-flair backgrounds are already filter-free — don't re-add.

**Cause 2 — `backdrop-filter` glass over animating content (the flicker).** A `backdrop-filter:blur` element re-samples whatever is behind it every frame; if that content moves (an animating ring/halo behind it), Chrome flickers the glass element and everything inside it. Worse when the moving content is crisp (sharp edges). **Fix:** keep the background **static** wherever glass overlays it (the Readiness halo is intentionally static for this reason), or drop the `backdrop-filter` on that element and use a higher-opacity solid backing.

**How to diagnose quickly (Playwright on the running `npx vite`):** restart the animation classes on the SVG and sample `requestAnimationFrame` intervals for ~1s — count frames > 32ms and the max frame. Then strip the filters (`el.removeAttribute('filter')`) and re-measure: a jump from ~30fps to ~60fps confirms Cause 1. For Cause 2, toggle the background animation off (or `backdrop-filter:none`) and see if the flicker stops. Full method + the rules are in `UX_PATTERNS.md → Mosaic Visual System → iOS Performance`.
