# Triathlon Agent Handoff

Items the prediction engine defers to the triathlon agent. The main-build prediction engine in `predictions.ts` / `prediction-inputs.ts` owns **extraction + current-fitness state per sport**. The triathlon agent consumes that state and handles multi-sport race prediction + pacing.

## Shared interface

The prediction engine will produce an `AthleteFitnessState` object. The triathlon agent reads it and layers triathlon-specific logic on top.

Shape (proposed — finalise together):

```ts
interface AthleteFitnessState {
  run: {
    vdot: number;                  // current effective VDOT (HR-calibrated)
    confidence: 'high' | 'medium' | 'low' | 'none';
    weeklyKm: number;
    runnerTypeBias: number;        // -1..+1, speed vs endurance
    predictions: {                 // standalone run-race predictions
      k5: number; k10: number; half: number; marathon: number;
    };
  };
  bike: {
    ftpWatts: number | null;
    cp: number | null;             // critical power
    wPrime: number | null;         // anaerobic work capacity
    confidence: 'high' | 'medium' | 'low' | 'none';
    weeklyHours: number;
  };
  swim: {
    cssSecPer100m: number | null;  // critical swim speed
    confidence: 'high' | 'medium' | 'low' | 'none';
    weeklyKm: number;
  };
  durability: {
    longSessionsPerWeek: number;   // ≥2h aerobic sessions (any sport)
    longestRecentSessionMin: number;
  };
}
```

## Items owned by the triathlon agent

1. **Race picker for flagship triathlons**
   - Short-race expansion (5K/10K marathon picker is already in main engine).
   - Add flagship 70.3 / Ironman courses (Kona, Nice, Roth, Cairns, Frankfurt, Lake Placid, Mont-Tremblant, etc.).
   - Curated table of course difficulty modifiers (`courseMedianOffsetMin`) so we can flag "Kona runs ~45 min slow vs median Ironman due to heat + hills".

2. **Triathlon-segment predictions** (distinct from standalone)
   - Swim leg: pool CSS → open-water adjustment (+5–10% typical).
   - Bike leg: CP/FTP → pacing at 70–78% FTP (70.3) or 65–72% (IM).
   - Off-bike run: 10–15% slower than open half at 70.3, 15–25% slower at IM full.
   - Both standalone and off-bike times, clearly labelled.

3. **Historic times at named courses**
   - Pull from curated list (Strava doesn't expose race-finish leaderboards cleanly).
   - Show user: "on this course, median finisher runs ~10:15 — you're predicted at 9:55, faster than ~65% of the field".

4. **Nutrition + pacing strategy**
   - Not in scope for the prediction engine at all.

## Clarifiers still outstanding

- Swim: pool vs open-water default? Main engine will trust Strava `SWIM` distance as-is — the triathlon agent decides how to apply open-water inflation.
- Short-race picker: 5K / 10K / 15K / 20K — main engine currently plans to add 5K/10K only. Confirm with triathlon agent whether they want 15K/20K.

## Notes for the triathlon agent

- Main engine only predicts **standalone** sport times from recent training. Any triathlon-segment adjustment (fatigue, transitions, pacing targets) is yours.
- Don't re-derive VDOT/FTP/CSS — consume `AthleteFitnessState.run.vdot` etc. directly. If confidence is `low`, fall back to user-entered PBs or prompt the user.
- Same build, different pages — data model is shared, view layer diverges per sport.

## Run prediction methodology (decided 2026-04-24)

The run prediction engine blends four signals into a single VDOT. The triathlon agent should mirror this structure for bike (FTP/CP) and swim (CSS).

**Blending model — weighted mean, not hierarchy:**

| Signal | Weight formula | Notes |
|---|---|---|
| HR-calibrated VDOT (Swain + Daniels regression) | `R² × min(N/8, 1) × recencyDecay` | Primary when available; needs RHR + maxHR + ≥3 valid points |
| Hard-effort VDOT (recent race/TT) | `0.8 × recencyDecay` | Race-flagged: pace ≥15% faster than median, ≤12 weeks old |
| Tanda VDOT (volume × pace) | `paceConfidenceFactor` (high 0.9 / med 0.6 / low 0.3) | Existing `prediction-inputs.ts` |
| PB VDOT | `0.5 × pbAgeDecay`, half-life 3 years | Ceiling signal; decays by Tanaka & Seals 2008 VO2max decline |

`recencyDecay = exp(-weeksOld / 12)`. `pbAgeDecay = exp(-yearsOld × ln(2) / 3)`.

**Why blending, not hierarchy:** independent signals → independent noise. Weighted mean gives lower-variance estimate than any single source. Matches how a coach reasons: "HR says 52, recent 5K says 54, year-old PB says 55 — call it 53 and improving."

**Missing data fallback:**
- No RHR → mark HR-calibrated confidence `none`, skip HR regression entirely. No fabricated default.
- No hard efforts in 12w → hard-effort weight = 0.
- No PBs → PB weight = 0.
- All zero → fall back to `paceConfidence = 'none'` and prompt user to enter a PB manually.

**Apply the same shape to bike + swim:**
- **Bike**: HR-calibrated FTP (power regression against %HRR if power meter absent; direct power duration curve if present), recent hard effort (20-min test, race), volume × avg power (Tanda analog), FTP PB.
- **Swim**: CSS from paired TT (400m + 50m per Ginn), recent race (1.5k/400m/800m), volume × pace proxy, CSS PB. Open-water GPS trusted as-is.
- Both use the same `w = f(confidence, sampleSize, recency)` weighting.

**Runner-type bias applies to run only.** The triathlon agent may want an analog for bike (sprint vs endurance rider from 5-min vs 60-min power ratio). Not built yet.

**Decay half-life 3 years applies to all PB types** — Tanaka & Seals masters VO2max decline generalises to aerobic-dominant sports. For swim where technique dominates, consider a longer half-life (not yet researched).

See `docs/SCIENCE_LOG.md → Effort-Calibrated VDOT from HR` for the full derivation and literature citations.

## Onboarding surface (decided 2026-04-25)

The HR-calibrated current-fitness signal is exposed on the onboarding **review** screen (`src/ui/wizard/steps/review.ts → renderVdotRow`) — not buried in the engine. Mirror this for bike + swim.

**Pattern:**
- One row per sport: "Current fitness (VDOT / FTP / CSS)".
- Display the calibrated value when confidence ≠ `'none'`, otherwise fall back to a PB-derived figure.
- Sub-caption explains the method in one line: *"Measured from how your heart rate responded to pace across N recent runs. {tier} confidence."* Replace pace→power for bike, pace→HR for swim CSS-from-paired-TT.
- When the signal is unavailable, the sub-caption tells the user what to add: *"Add a resting HR in your profile to refine this from your recent training."* Map to bike (FTP test or paired power-meter sessions) and swim (CSS pair).

**Cache shape on state** — copy the existing pattern. Each sport gets a `hrCalibrated{Vdot|Ftp|Css}` field on `SimulatorState`:

```ts
hrCalibratedVdot?: { vdot: number | null; confidence: 'high'|'medium'|'low'|'none'; n: number; r2: number | null; reason?: '...' };
hrCalibratedFtp?: { ftp: number | null; confidence: ...; n: ...; r2: ... };
hrCalibratedCss?: { css: number | null; confidence: ...; n: ...; r2: ... };
```

Populate in `refreshBlendedFitness` *before* the early-return guards. The review screen needs these even when race distance / triathlon focus isn't picked yet.

**Confidence tier copy (canonical):**
- `high` → "High confidence"
- `medium` → "Medium confidence"
- `low` → "Low confidence"
- `none` → no row, or fall back to PB-derived figure with the prompt-to-add-RHR sub-caption.

**Why surface this in onboarding:** the user sees a number with no preamble — the sub-caption is the only place they learn it came from *their* data, not a default. Without that explanation the figure reads like a guess. With it, the rest of the app (predicted finish time, planned paces) inherits credibility. Same applies on bike + swim.
