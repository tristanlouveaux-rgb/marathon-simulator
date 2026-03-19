# Agent Session Primer — Mosaic Marathon Simulator

> **Read this file first at the start of every session.**
> Then read the files listed below before touching any code.

---

## Required reading order (every session)

1. **`docs/PRINCIPLES.md`** — The "why". Signal model, protection hierarchy, resolved design decisions.
   If you are about to change load calculation, stats display, or plan adjustment logic — re-read this.

2. **`docs/OPEN_ISSUES.md`** — Current bugs and features. Check before adding anything new.
   P1 = broken/misleading. P2 = confusing. P3 = future.
   ✅ items are done. Don't re-open them. Don't re-introduce their bugs.

3. **`docs/LOAD_MODEL_PLAN.md`** — Phase-by-phase build tracker for the load model rebuild.
   Phases 1–7 ✅. Phase 8 (Tier 1 auto-apply) is next.

4. **`docs/MODEL.md`** — Math reference. VDOT, CTL/ATL, iTRIMP, ACWR, Signal A/B/C.
   Read if you are unsure how a calculation is supposed to work.

---

## Decisions already made — do not re-derive

| Topic | Decision | Where |
|---|---|---|
| ACWR uses Signal B acute, Signal A chronic | Ratio = total fatigue ÷ running adaptation | PRINCIPLES.md |
| Tier thresholds | 0–15 auto, 15–40 nudge card, ACWR high = modal | PRINCIPLES.md |
| Protection order | Easy run → long run distance → threshold intensity → VO2 intensity | PRINCIPLES.md |
| Quality sessions | Never auto-cancelled; may be downgraded in intensity only | PRINCIPLES.md |
| Signal B baseline | 8-week EMA of `historicWeeklyRawTSS` (not 4-week, not current week) | PRINCIPLES.md |
| Timing check threshold | Signal B ≥ 30 TSS within 1 calendar day → intensity downgrade | PRINCIPLES.md |
| Strength runSpec | 0.35 (compound leg work has partial running transfer) | LOAD_MODEL_PLAN Phase 3 |
| Strava pace field | `moving_time` for pace, `elapsed_time` for iTRIMP duration | OPEN_ISSUES ISSUE-13 |
| General fitness skip | Must mirror race mode (skip → next week → skip again → manual drop) | OPEN_ISSUES ISSUE-16 |

---

## Current state snapshot

- **Load model**: Phases 1–7 done. Phase 8 (Tier 1 auto-adjust) is next in `LOAD_MODEL_PLAN.md`.
- **Active P1 bugs**: ISSUE-16, ISSUE-17, ISSUE-53, ISSUE-54, ISSUE-57
- **On hold**: ISSUE-47 (What-if sandbox) — fully scoped, not yet started
- **`[ui-ux-pro-max]` items**: Reserved for a dedicated UX session using that skill

---

## How to end a session

Before closing, ask me to update `PRINCIPLES.md` with any design decisions made during this session.
Format: add a new `### [topic]` block under the most recent `## Resolved Design Decisions` heading.

---

## What NOT to do

- Do not change Signal A/B split logic without re-reading PRINCIPLES.md first
- Do not use `elapsed_time` for pace calculation (ISSUE-13 — fixed, don't regress)
- Do not auto-cancel quality sessions for any reason
- Do not add new P1 bugs to the bottom of OPEN_ISSUES — they go in the P1 section
- Do not invent VDOT or CTL algorithms — read MODEL.md first

---

*Last updated: 2026-03-04*
