# Issue Crusher — Batch 3.1 (Training Readiness UX Polish)

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH3_1.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 3 merged. Training Readiness ring is live.
> **Context**: First-use feedback — readiness ring shows 39 but user can't tell WHY.

---

## MANDATORY READING

1. `docs/specs/TRAINING_READINESS_SPEC.md` — the full spec
2. `src/calculations/readiness.ts` — the computation (correctly implemented)
3. `src/ui/home-view.ts` — ring rendering + click handler

## RULES

1. Same rules as Batch 3.
2. **Do NOT change the readiness formula.** It's correct.
3. **No jargon.** Never show CTL, ATL, TSB, ACWR in user-facing UI.
4. Quality gates: `npx tsc --noEmit` + `npx vitest run` before every commit.

---

## The Problem

The ring shows "39 · Ease Back · Deep fatigue. Rest day." but:
1. User **can't tell which sub-metric is driving the low score**
2. Sub-metric pills are **not clickable** — no way to explore what each means
3. Second tap either goes to Stats or fires ACWR reduction — **WRONG behaviour**. When readiness is low due to fatigue (not ACWR), tapping should offer fatigue-specific advice
4. **No "Adjust session" button** visible when readiness ≤ 59 — the action should be obvious without needing a second tap
5. Momentum pill shows "**CTL 195**" — violates no-jargon rule. Should say "Fitness 195" or just the arrow + "Stable"

---

## ISSUE 1 — Highlight the driving signal

**Currently**: All 4 pills look the same visually. User has to mentally compare numbers.

**Fix**: The pill that matches `readiness.drivingSignal` should:
- Have a coloured left border (e.g. `border-left: 3px solid var(--c-warn)`)
- Show a small label like "⬇ Main factor" below the zone text
- The pill's value colour already turns red for bad scores — keep that

**Example**: If `drivingSignal === 'fitness'`, the Freshness pill gets the highlight and shows "⬇ Main factor" underneath "Overtrained".

**File**: `src/ui/home-view.ts`, lines 356–380 (the pills section)

---

## ISSUE 2 — Each pill tappable with its own info sheet

**Currently**: Tapping the card expands/collapses all pills. No individual detail.

**Fix**: Each pill should be individually tappable. On tap, show a bottom-sheet overlay explaining that specific metric:

### Freshness pill → Freshness info sheet
- What it is: "How recovered you are right now"
- Current value: "-57 (Overtrained)"
- What it means: "Your short-term load greatly exceeds your fitness. You've accumulated deep fatigue."
- What to do: "Take 1-2 rest days. When you train, keep effort very easy."
- Scale bar: Overtrained ← Fatigued ← Recovering ← Fresh ← Peaked (with marker at current position)

### Load Safety pill → Load Safety info sheet
- What it is: "How fast your training load is increasing"
- Current value: "1.29× (Safe)"
- What it means: "Your recent load is similar to your baseline — safe territory."
- Scale bar: Safe ← Moderate Risk ← High Risk

### Momentum pill → Momentum info sheet
- What it is: "Whether your fitness is trending up or down"
- Current value: "→ Stable (Fitness: 195)"
- What it means: "Your fitness baseline is holding steady."

### Recovery pill → Recovery info sheet
- What it is: "How well your body has recovered overnight"
- Current: "Sleep 60/100" + RHR if available
- What to do: "Prioritise sleep quality tonight."
- OR if greyed out: "Connect a Garmin watch to see your recovery data"

**Implementation**:
- Add `data-pill="fitness|safety|momentum|recovery"` to each pill div
- Wire click handlers that call a new `showPillInfoSheet(signal)` function
- The info sheet reuses the same bottom-sheet pattern as `showACWRInfoSheet()` and `showTSSInfoSheet()` in `main-view.ts`
- **Stop event propagation** on pill click so it doesn't also trigger the card expand/collapse

**Files**: `src/ui/home-view.ts`

---

## ISSUE 3 — "Adjust session" button when readiness ≤ 59

**Currently**: When readiness is low and you tap the ring a second time:
- If ACWR is caution/high → calls `triggerACWRReduction()` ✅
- If ACWR is safe (like the user's case: 1.29×) → goes to Stats page ❌

**The user's readiness is 39 but ACWR is safe.** The low score is from fatigue, not load safety. The second tap goes to stats — useless.

**Fix**: Replace the second-tap logic with a visible "Adjust session" button:

1. When readiness score ≤ 59, show a button below the pills:
   ```html
   <button id="readiness-adjust-btn" class="...">
     Adjust today's session
   </button>
   ```

2. The button text varies by driving signal:
   - `fitness` → "Swap to easy run"
   - `safety` → "Reduce session load"
   - `recovery` → "Take it lighter today"
   - `momentum` → "Keep consistency — don't skip"

3. On click:
   - If there are unrated workouts remaining today → call `triggerACWRReduction()` (which shows the swap/reduce modal)
   - If all today's workouts are already rated or reduced → show: "You've already adjusted today's session. Nice one. 👍"

4. Remove the second-tap-goes-to-stats behaviour. The ring card tap just toggles pills open/closed.

**Files**: `src/ui/home-view.ts` (lines 971–997, the click handler)

---

## ISSUE 4 — Fix Momentum pill jargon

**Currently**: Momentum pill shows "CTL 195"

**Fix**: Change to one of:
- "Fitness 195" (acceptable — "Running Fitness" is our human name for CTL)
- Or just the arrow + zone label: "→ Stable" without the number

I recommend "Fitness 195" — the number is useful, just needs the right label.

**File**: `src/ui/home-view.ts`, line 373
```diff
- <div style="font-size:10px;color:var(--c-faint)">CTL ${ctlNow.toFixed(0)}</div>
+ <div style="font-size:10px;color:var(--c-faint)">Fitness ${ctlNow.toFixed(0)}</div>
```

---

## ISSUE 5 — Delete deprecated buildSignalBars

**Currently**: The old `buildSignalBars()` function is still in the file, marked `@deprecated`.

**Fix**: Delete it entirely (lines ~387–500). It's dead code. The readiness ring has replaced it. Keeping it risks confusion.

**File**: `src/ui/home-view.ts`

---

## ISSUE 6 — Recovery pill colour should reflect score

**Currently**: Recovery pill always shows `var(--c-ok)` (green) regardless of score.

**Fix**: Use the same colour logic as other pills:
```typescript
const recoveryColor = readiness.recoveryScore != null
  ? (readiness.recoveryScore < 40 ? 'var(--c-warn)' : readiness.recoveryScore < 65 ? 'var(--c-caution)' : 'var(--c-ok)')
  : 'var(--c-faint)';
```

The user has Recovery 60/100 showing in green — it should be amber (< 65).

**File**: `src/ui/home-view.ts`, line 310

---

## WHEN DONE

1. Run `npx tsc --noEmit` — clean
2. Run `npx vitest run` — all pass
3. Run `npx vite build` — compiles
4. Summary table with issue, status, commit hash
