# Issue Crusher — Batch 3.2 (TSB Signal Fix)

> **How to use**: `claude "Read docs/ISSUE_CRUSHER_BATCH3_2.md. Fix the issues in order."`
>
> **Prerequisites**: Batch 3.1 merged.
> **Context**: Structural bug — cross-trainers get permanently negative TSB due to Signal A/B mismatch.

---

## MANDATORY READING

1. `docs/specs/TRAINING_READINESS_SPEC.md`
2. `src/calculations/readiness.ts`
3. `src/calculations/fitness-model.ts` — pay attention to `computeWeekTSS` (Signal A) vs `computeWeekRawTSS` (Signal B)

## RULES

1. Same rules as all batches.
2. **Do NOT change `computeFitnessModel`.** The mixed-signal model is correct for its purpose (load management). We're fixing readiness only.
3. Quality gates: `npx tsc --noEmit` + `npx vitest run` before every commit.

---

## THE BUG

### What's happening

TSB is computed as `CTL - ATL` inside `computeFitnessModel`. But:

- **CTL** updates using `computeWeekTSS` (Signal A) — cross-training is **discounted** via `runSpec` (e.g. tennis at 0.35×, gym at 0.3×)
- **ATL** updates using `computeWeekRawTSS` (Signal B) — cross-training counts at **full physiological weight** (1.0×)

For an athlete doing running + tennis + gym with weekly split of:
- Running: 120 TSS
- Cross-training: 80 TSS raw

Signal A contribution: `120 + (80 × 0.35) = 148`
Signal B contribution: `120 + 80 = 200`

Over time: CTL → ~148, ATL → ~200, TSB → **-52 permanently**.

### Why this is wrong for readiness

The readiness formula uses TSB to determine "freshness." TSB of -52 maps to fitnessScore = 0, which drags the entire readiness score into "Ease Back." But the athlete isn't overtrained — they're just doing cross-training that Signal A intentionally discounts.

### Why `computeFitnessModel` isn't broken

The mixed-signal model is **correct for load management**. CTL (Signal A) measures running-specific adaptation. ATL (Signal B) measures total physiological fatigue. TSB from the existing model answers: "how much running can your legs handle?" — which is the right question for the plan view.

But readiness needs to answer: "how fatigued are you overall?" — which requires **same-signal comparison**.

---

## THE FIX

### ISSUE 1 — Add same-signal TSB computation for readiness

**Create** a new function in `src/calculations/fitness-model.ts`:

```typescript
/**
 * Compute same-signal CTL and ATL using Signal B only.
 * Used by readiness to get a fair freshness reading for cross-trainers.
 * Signal B = full physiological load (no runSpec discount).
 */
export function computeSameSignalTSB(
  wks: Week[],
  currentWeek: number,
  ctlSeed?: number,
  planStartDate?: string,
): { ctl: number; atl: number; tsb: number } | null {
  let ctl = ctlSeed ?? 0;
  let atl = ctlSeed ?? 0;  // SAME seed for both — no inflation

  const limit = Math.min(currentWeek, wks.length);
  if (limit === 0) return null;

  for (let i = 0; i < limit; i++) {
    const wk = wks[i];
    const rated = wk.rated ?? {};
    const weekRawTSS = computeWeekRawTSS(wk, rated, planStartDate);

    // ATL inflation from overrides/recovery debt still applies
    let atlMultiplier = 1.0;
    if (wk.acwrOverridden) atlMultiplier = 1.15;
    if (wk.recoveryDebt === 'orange') atlMultiplier = Math.max(atlMultiplier, 1.10);
    if (wk.recoveryDebt === 'red') atlMultiplier = Math.max(atlMultiplier, 1.20);
    const atlTSS = atlMultiplier > 1.0 ? Math.round(weekRawTSS * atlMultiplier) : weekRawTSS;

    ctl = ctl * CTL_DECAY + weekRawTSS * (1 - CTL_DECAY);  // Signal B for BOTH
    atl = atl * ATL_DECAY + atlTSS * (1 - ATL_DECAY);       // Signal B for BOTH
  }

  return { ctl, atl, tsb: ctl - atl };
}
```

**Key difference**: Both CTL and ATL use `computeWeekRawTSS` (Signal B). The ATL seed is the SAME as CTL seed — no gym multiplier inflation.

**Export** `CTL_DECAY` and `ATL_DECAY` from the file (or just use the same constants inline).

---

### ISSUE 2 — Wire readiness to use same-signal TSB

**Modify** `src/ui/home-view.ts`, function `buildReadinessRing`:

Replace:
```typescript
const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
const latest = metrics[metrics.length - 1];
const tsb = latest?.tsb ?? 0;
const ctlNow = latest?.ctl ?? 0;
```

With:
```typescript
// For readiness: use same-signal TSB (Signal B for both CTL and ATL)
// so cross-trainers aren't penalised by the A/B split
const sameSignal = computeSameSignalTSB(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate);
const tsb = sameSignal?.tsb ?? 0;
const ctlNow = sameSignal?.ctl ?? 0;

// Still need original metrics for 4-week lookback
const metrics = computeFitnessModel(s.wks ?? [], s.w, s.ctlBaseline ?? undefined, s.planStartDate, atlSeed);
```

Keep using the original `metrics` for `ctlFourWeeksAgo` and `weeksOfHistory`.

---

### ISSUE 3 — Tests

**Add** tests to `src/calculations/readiness.test.ts`:

```typescript
describe('same-signal TSB for cross-trainers', () => {
  it('should not penalise athletes with high cross-training load', () => {
    // Simulate: athlete with 120 running + 80 cross-training each week
    // Signal A TSS per week ≈ 148, Signal B TSS per week ≈ 200
    // Mixed-signal TSB should be very negative
    // Same-signal TSB should be near 0 (steady state)
    const result = computeReadiness({
      tsb: -5,  // same-signal: nearly balanced
      acwr: 1.1,
      ctlNow: 200,
      ctlFourWeeksAgo: 190,
    });
    expect(result.score).toBeGreaterThan(60); // should be "On Track" or better
  });

  it('should still detect genuine overtraining', () => {
    // Even with same-signal, a spike week should produce negative TSB
    const result = computeReadiness({
      tsb: -30,  // genuinely fatigued even on same signal
      acwr: 1.4,
      ctlNow: 150,
      ctlFourWeeksAgo: 150,
    });
    expect(result.score).toBeLessThan(50); // should be "Manage Load" or worse
  });
});
```

**Add** unit tests for `computeSameSignalTSB` in `src/calculations/fitness-model.test.ts`:

- Steady state: 10 weeks of identical Signal B → TSB should converge near 0
- Spike week: TSB should go negative
- Light week: TSB should go positive

---

## WHEN DONE

1. `npx tsc --noEmit` — clean
2. `npx vitest run` — all pass
3. `npx vite build` — compiles
4. Summary table
