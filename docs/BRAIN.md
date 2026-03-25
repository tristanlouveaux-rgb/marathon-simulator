# The Brain — Coaching Intelligence Design

## The Problem

The app collects a lot of signal. Right now that signal fires in isolation:

- `readiness.ts` scores TSB + sleep + HRV — but doesn't know about injury or illness
- `coach-insight.ts` computes RPE × load for the week — but doesn't know about sleep
- `sleep-insights.ts` spots post-hard-week patterns — but can't affect the plan
- `illness-modal.ts` captures illness flag — wired to nothing downstream
- `workout-insight.ts` analyses HR drift and splits per workout — not aggregated across the week
- `injury/engine.ts` manages injury state — isolated from readiness score

No single function answers: "Given everything we know right now — what is the actual coaching stance for today?"

---

## Signal Map (what exists, where it lives)

| Signal | Source | Currently fed into |
|---|---|---|
| Sleep score / duration | `physiologyHistory[]` | `readiness.ts`, `sleep-insights.ts` |
| HRV (RMSSD) | `physiologyHistory[]` | `readiness.ts` |
| Sleep bank (7-day debt) | `physiologyHistory[]` | `readiness.ts` |
| REM % *(coming)* | `physiologyHistory[]` | nothing yet |
| TSB (Freshness) | `fitness-model.ts` | `readiness.ts` |
| ACWR (Load Safety) | `fitness-model.ts` | `readiness.ts` |
| CTL trend | `fitness-model.ts` | `readiness.ts`, `coach-insight.ts` |
| Weekly TSS % of plan | `fitness-model.ts` | `coach-insight.ts` |
| RPE (effort score) | `wk.rated[]` | `coach-insight.ts` |
| HR drift (aerobic efficiency) | `wk.garminActuals` | `coach-insight.ts` (weekly avg), `workout-insight.ts` (per session) |
| Pace adherence / splits | `wk.garminActuals` | `workout-insight.ts` (per session) |
| Injury state | `s.injuryState` | `injury/engine.ts` only |
| Illness flag | `illness-modal.ts` | **nothing** |
| Check-in (how are you feeling?) | `checkin-overlay.ts` | **nothing** |
| VDOT trend | computed once from Strava | no history stored |

---

## The Central Brain — `daily-coach.ts`

A single function called on every app load that collates all signals and returns a structured `CoachState` object. This is the authoritative source for:

- What today's coaching stance is
- Whether the plan should be modified
- What the user should see on the Brain tab

```ts
interface CoachState {
  stance: 'push' | 'normal' | 'reduce' | 'rest';
  readiness: ReadinessResult;           // existing
  weekSignals: WeekSignals;             // existing
  sleepInsight: string | null;          // existing
  workoutMod: 'none' | 'downgrade' | 'skip';
  alertLevel: 'ok' | 'caution' | 'warning';
  primaryMessage: string;               // single highest-priority sentence
  secondaryMessages: string[];          // supporting context (2-3 max)
  blockers: Array<'injury' | 'illness' | 'overload' | 'sleep'>;
}
```

### Priority hierarchy for `primaryMessage`

Highest priority wins:

1. **Injury active** — overrides everything regardless of other signals
2. **Illness flag set** — rest is mandatory, block quality sessions
3. **ACWR > 1.5** — load safety critical, immediate risk
4. **Sleep + ACWR combined bad** — compounding recovery + load collision
5. **HRV suppressed + high load** — physiological stress signal
6. **Post-hard-week + poor sleep** — carry-forward from previous week RPE
7. **Normal coach copy** — default readiness narrative

### How it affects the plan

`workoutMod` is an instruction to the plan renderer:

- `'none'` — show workout as-is
- `'downgrade'` — show workout with pace/intensity reduced (e.g. threshold → steady, steady → easy)
- `'skip'` — surface a "consider rest day" prompt

The plan should read `CoachState.workoutMod` before rendering today's card. This replaces the current scattered inline logic in `home-view.ts` and `plan-view.ts`.

---

## The Brain Tab

A dedicated tab that surfaces everything in one place. Not a dashboard of widgets — a single coherent read on where the athlete is right now.

### Structure

```
┌─────────────────────────────────────────────┐
│  Today's stance: [REDUCE / NORMAL / PUSH]   │  ← large, dominant
│  "Hard week on limited sleep. Back off       │
│   intensity today."                          │
└─────────────────────────────────────────────┘

┌── This week ────────────────────────────────┐
│  Effort: Hard   Load: Below plan            │  ← existing signal pills
│  "Last week's effort was high but volume    │
│   came in below target..."                  │
└─────────────────────────────────────────────┘

┌── Recovery ─────────────────────────────────┐
│  Readiness: 58 — Manage Load                │
│  Sleep last night: 62  7-day avg: 71        │
│  HRV: 42ms  (−8ms vs baseline)             │
│  Sleep bank: −3.5h this week                │
└─────────────────────────────────────────────┘

┌── Fitness ──────────────────────────────────┐
│  Running fitness: 31.3  ↓ from 33.1        │
│  Training load: 63 TSS (32% of plan)        │
│  Trend: 4-week CTL down 2.1 pts             │
└─────────────────────────────────────────────┘

┌── Status ───────────────────────────────────┐
│  [Injury: none]  [Illness: none]            │
│  [Check in →]                               │
└─────────────────────────────────────────────┘
```

The stance block is the hero. Everything else is supporting evidence for why the stance is what it is.

### Design rules

- Max 2 non-neutral colours. Red for warning/blocker, amber for caution. Green only for readiness label.
- Sections are plain rows, no tinted cards, no decorative gradients.
- "Check in →" is the only CTA. Opens `checkin-overlay.ts`.
- The stance label uses the same vocabulary as the readiness label: **Ready to Push / On Track / Manage Load / Ease Back** — do not invent new terms.

---

## Build Status

### Phase 1 — Wire existing signals ✅ BUILT (2026-03-22)

1. ✅ **`src/calculations/daily-coach.ts`** — `computeDailyCoach(state)` aggregates all signals into `CoachState` with `stance`, `blockers`, `alertLevel`, and `CoachSignals` payload.
2. ✅ **Illness state** — `s.illnessState` already existed on `SimulatorState`. Read as blocker in `daily-coach.ts`.
3. ✅ **`supabase/functions/coach-narrative/index.ts`** — Haiku LLM call. System prompt enforces direct/factual tone. Rate limit: 3 calls/day, 4h cache in localStorage.
4. ✅ **`src/ui/coach-modal.ts`** — Coach overlay with readiness ring, 5 signal rows, LLM narrative card.
5. ✅ **Coach button** — added to Home header and Plan header (current week only), same pill style as Check-in.

**Pending before Phase 1 is live:**
- Deploy edge function: `supabase functions deploy coach-narrative`
- Set secret: `supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`

### Phase 2 — Add missing data points (not started)

6. **Subjective daily feeling** — "How do you feel today?" 4-option tap (`Struggling / Ok / Good / Great`) → `s.todayFeeling` on state. Drops/raises stance by one level. Expires end of day.
7. **VDOT history sparkline** — `vdotHistory` already stored on state (`{week, vdot, date}[]`). Need to surface "fitness direction" as a real trend in `CoachSignals` rather than just 4-week CTL delta.
8. **Weekly aerobic efficiency trend** — aggregate `hrDrift` across `garminActuals` for the past 4 weeks. Detects aerobic efficiency decline before VDOT changes.
9. **REM %** — once Garmin/Apple surface this in `physiologyHistory`, slots into `readiness.ts` as a sub-signal on sleep quality.
10. **Previous-week carry-forward** — if last week's `CoachState.stance` was `'reduce'` or `'rest'`, this week's base readiness starts discounted. Prevents whiplash.

---

## What the Check-In Feeds

The check-in (currently: Injured / Ill / Holiday) should expand to include a daily subjective rating. This is the cheapest possible signal — one tap, zero sensor required.

Proposed flow on app open (or from the Brain tab):

```
How do you feel today?
  [ Struggling ]  [ Ok ]  [ Good ]  [ Great ]
```

Maps to a modifier on `CoachState.stance`:
- **Struggling** → drops stance one level (Push → Normal, Normal → Reduce, Reduce → Rest)
- **Good / Great** → slight positive modifier on readiness score (not enough to override hard limits)
- **Ok** → no change

This is stored as `s.todayFeeling: 'struggling' | 'ok' | 'good' | 'great' | null` and expires at end of day.

---

## What Connects to What (target state)

```
physiologyHistory  ──→  readiness.ts  ──┐
s.injuryState      ──────────────────────┤
s.illnessFlag      ──────────────────────┤
s.todayFeeling     ──────────────────────┤──→  daily-coach.ts  ──→  CoachState
fitness-model.ts   ──→  TSB/ACWR/CTL  ──┤                              │
wk.rated           ──→  coach-insight ──┤                              │
wk.garminActuals   ──→  hrDrift/RPE   ──┘                              │
                                                                        │
                                          ┌─────────────────────────────┘
                                          ↓
                                    Brain tab (read)
                                    home-view.ts (today's workout card)
                                    plan-view.ts (workout mod badge)
                                    week-debrief.ts (weekly summary)
```

---

## Open Questions for Tristan

Before building the Brain tab:

1. **Tab position** — does Brain replace Stats, sit alongside it, or is it a sub-page off Home?
2. **Stance vocabulary** — use the existing readiness labels (Ready to Push / On Track / Manage Load / Ease Back) or introduce a simpler set (Push / Normal / Back Off / Rest)?
3. **Subjective check-in** — do you want the daily feeling prompt on app open, or only accessible from the Brain tab?
4. **Illness severity** — should illness always force `stance = 'rest'`, or only above a severity threshold (mild illness = reduce, moderate/severe = rest)?
5. **LLM narrative** — rules-based copy only for now, or do you want an LLM call for the `primaryMessage`? (Option C from our earlier discussion)
