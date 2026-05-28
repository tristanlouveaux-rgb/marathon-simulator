# Morning briefing — AI Coach v3 mega-run

**Date**: 2026-05-15 (run completed overnight 2026-05-14 → -15)
**Status**: All planned phases green. One manual step needed before live evals can run.

## TL;DR

All five v3 levers shipped (Memory, Evals, Evidence/Confidence, Priorities, Proactive). Overnight audit found and fixed three bugs — including one P0 data-corruption issue for HYROX users that would have silently no-op'd every Apply tap. 68 unit tests added, eval suite expanded 14 → 25 scenarios. Full repo test suite **1961 passing**.

**Update (2026-05-16)**: A second independent audit (code-reviewer + Explore agents) surfaced two more P0 silent-corruption bugs. Both fixed with regression tests:
- `scaleWorkoutDescription` was scaling interval rep distances (`8x100m` → `8x70m`), destroying interval prescriptions.
- `buildPlanSkeleton` missed HYROX — same class of bug as the first audit's P0, different file.

P1/P2 punch list (10 items) logged to OPEN_ISSUES.md as ISSUE-208/-209 + a few inline notes — deferred for the next pass, not blocking dogfood.

You can dogfood immediately. Live evals need one `.env.local` line first.

## What shipped overnight

**Phase 1 — Bug fixes**:

- ✅ **ISSUE-205 (P0)** — `applyPendingChange` now correctly handles HYROX. Previously fell through to running branch, wrote to the wrong array. Now HYROX uses the same in-place `triWorkouts` mutation as triathlon. Regression test in place.
- ✅ **ISSUE-207 (P1)** — `adjust_intensity` zoneCap is no longer a silent no-op in running. Mod-application loops in `plan-view.ts` propagate `zoneCap`, `aiModifiedAt`, and `autoReduceNote` onto the workout. Coach context emits an `ai_modifications` array so the coach knows its past calls.
- ✅ **ISSUE-206 (P2)** — Coach gate chain hardened against inconsistent state. New `buildHyroxCoachContext` in `coach-context-builder.ts` for HYROX users. HYROX workout card renders the "Coach" badge.

**Phase 2 — Unit tests** (68 new, all pass):

- `coach-view-helpers.test.ts` (32) — pure parsing helpers
- `coach-triggers.test.ts` (15) — trigger detector + queue helpers
- `coach-tools.test.ts` (21) — every tool, every mode, full apply + undo round-trips

Plus 2 production bugs found via tests:
- `isClearDirective("30")` now correctly detected as a directive (was rejected by length guard)
- `scaleWorkoutDescription` no longer double-scales `1h 30min` compounds

**Phase 3 — Evals** (25 scenarios, was 14):

11 new scenarios covering running mode, HYROX mode, illness handling, ambiguous directives, memory conflicts, jailbreak variants, low-confidence cases, and priority-weighted recommendations.

**Phase 4 — Docs**:

- `docs/FEATURES.md` — AI Coach section rewritten as v3
- `docs/CHANGELOG.md` — mega-run entry
- `docs/OPEN_ISSUES.md` — ISSUE-205, 206, 207 added (all FIXED)

## What's verified vs what still needs your eyes

| | Verified | Needs you |
|---|---|---|
| Typecheck (`npx tsc --noEmit`) | ✅ Clean | — |
| Unit tests (`npm test`) | ✅ 1961 passing | — |
| Skip gate on eval suite | ✅ Skips cleanly without env var | — |
| Live eval run (`npm run coach:eval`) | ⚠️ Couldn't run | Set env var, then run |
| Manual smoke test | — | 5 lines below |

## The single manual step before you dogfood

**Copy your Anthropic API key into `.env.local`** so the local eval suite can call Haiku directly:

```bash
# In /Users/tristanlouveaux/Documents/marathon-simulator
echo "ANTHROPIC_API_KEY=sk-ant-api03-..." >> .env.local
```

Use the same key value you set as a Supabase secret. Once it's in `.env.local`:

```bash
npm run coach:eval
```

You'll see a pass/fail grid for all 25 scenarios with per-scenario tokens + cost. Expected total cost: $0.10–$0.30. Hard ceiling at $1.

## The edge function deploy state

`supabase/functions/coach-chat/index.ts` includes the `force_tool_use` handling (Sprint B). If you redeployed after Sprint B yesterday — you already shipped this. If not, redeploy:

```bash
supabase functions deploy coach-chat
```

No new env vars required — `ANTHROPIC_API_KEY` and `ALLOWED_USER_IDS` are unchanged from yesterday.

## 5-minute manual smoke test

1. **Memory works end-to-end**
   - Open Coach → say "I prefer Tuesday and Thursday for quality sessions"
   - Should produce: ack sentence → "Remember this" card with the fact in italics
   - Tap **Save** → toast "Saved to memory"
   - Tap **↻** for a fresh session — coach should reference the preference unprompted in the new brief

2. **Tool calls fire on directives**
   - In a fresh session, say "reduce Tuesday's swim by 30%"
   - Should produce: short ack → Apply card → chip replies below the message
   - Tap Apply → toast appears → Plan view shows reduced swim (~2310m) with "(reduced 30%)" suffix + "Coach" badge

3. **HYROX mode now works** (was the P0 fix)
   - If you're in HYROX mode: ask the coach to reduce a station session
   - The plan card should visibly change (it didn't before this fix)

4. **Confidence pill renders**
   - Ask "what is my current FTP?" — response should include a specific number AND show a small green dot + "High confidence" pill below the message

5. **Proactive insight card** (only if conditions match)
   - If your HRV is suppressed >15% below baseline this week, or your FTP just jumped >=5W, or a race is within 7 days — a "Coach insight" card should appear on Home

## Repo state

- Branch: `triathlon-mvp`
- Files changed since yesterday: ~12 source + 5 test + 4 doc
- Commits: none yet — review and commit when you're happy
- Linter: pre-existing `plan-view.ts` violations remain (not from this run)

## What I'd do first if I were you

1. Read this file. (Done.)
2. Drop `ANTHROPIC_API_KEY` into `.env.local`. Run `npm run coach:eval`. If anything is RED, paste me the assistant text and I'll debug the prompt.
3. Run the 5-minute smoke test above.
4. If everything green, commit the v3 + mega-run work (one commit if you prefer, or sprint-by-sprint if you want a clean history).
5. Decide what's next: Stripe paywall? More dogfood-driven prompt iteration? Open up the allowlist?

## What's explicitly NOT in this run

- No new features (no 6th lever)
- No Stripe / paywall work
- No edge function redeploy attempted from my side (it's a one-line manual step)
- No commits made (you control the history)
- No external service calls — everything stayed local

## If you want to roll back

Every change is in working-tree. `git diff` to see what was modified. `git checkout -- <file>` reverts a specific file. The bug fixes are independent of the unit tests and the eval expansion — you can revert any one phase without breaking the others.
