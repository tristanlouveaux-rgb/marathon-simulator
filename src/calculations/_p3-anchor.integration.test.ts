/**
 * _p3-anchor.integration.test.ts
 *
 * ADVERSARIAL VERIFICATION of three shipped features.
 * Each test section clearly labels what is EXECUTED vs what is INSPECTED/TRANSCRIBED.
 *
 * THING 1 (P3a): swim progression blend — end-to-end via REAL applyTriEffortMultipliers
 * THING 2 (P3b): activity-matcher mod re-attachment — REAL findWorkoutForMod + INSPECTION
 * THING 3 (anchor-gate): FTP/CSS detrain anchor clobber fix — TRANSCRIBED gate logic
 */

import { describe, it, expect } from 'vitest';
import {
  triTrailingEffortScore,
  applyTriEffortMultipliers,
} from './effort-multiplier.triathlon';
import { findWorkoutForMod } from '@/workouts/workout-scaling';
import type { SimulatorState, Workout } from '@/types/state';

// ─────────────────────────────────────────────────────────────────────────────
// THING 1 (P3a): Swim progression blend — EXECUTED against real code
// ─────────────────────────────────────────────────────────────────────────────
//
// What is EXECUTED: triTrailingEffortScore (real), applyTriEffortMultipliers (real)
// We build a minimal SimulatorState with a completed week (w=1) containing a swim
// workout matched to a garminActual carrying paceAdherence. Then we call the real
// applyTriEffortMultipliers on a future week's swim workout and observe the direction
// of the duration change.
//
// FORMULA being tested (effort-multiplier.triathlon.ts:112-117):
//   swimObjectiveDev = (1.0 - paceAdherence) * 10
//   dev = rpeDev * 0.4 + swimObjectiveDev * 0.6   (when paceAdherence present)
//   multiplier = 1 - score * 0.05  (clamped [0.85, 1.15])
//   futureWorkout.estimatedDurationMin *= multiplier

function buildSwimState(paceAdherence: number): SimulatorState {
  // Swim workout: planned RPE 5, rated RPE 5 (neutral RPE, isolate objective signal)
  const swimWorkout: any = {
    id: 'swim-wk0',
    t: 'easy',
    n: 'Aerobic Swim',
    d: '2000m easy',
    r: 5,                   // planned RPE
    discipline: 'swim',
    estimatedDurationMin: 60,
    matchedActivityId: 'act-swim-1',
  };
  const garminActual: any = {
    paceAdherence,          // the key signal under test
    // No durationSec → under-duration guard stays inert
  };
  return {
    eventType: 'triathlon',
    w: 1,                   // current week = 1; history is week 0
    wks: [
      {
        triWorkouts: [swimWorkout],
        rated: { 'swim-wk0': 5 },    // rated RPE = 5 = planned → rpeDev = 0
        garminActuals: { 'act-swim-1': garminActual },
      },
    ],
    triConfig: { distance: 'ironman' },
  } as unknown as SimulatorState;
}

describe('THING 1 (P3a) — swim progression blend (EXECUTED)', () => {
  it('FASTER than target (paceAdherence 0.9) → harder → multiplier < 1 → next swim SHORTER', () => {
    const state = buildSwimState(0.9);
    // Manual computation for transparency:
    //   swimObjectiveDev = (1.0 - 0.9) * 10 = 1.0
    //   rpeDev = 5 - 5 = 0
    //   dev = 0 * 0.4 + 1.0 * 0.6 = 0.6
    //   score = 0.6 (trailing avg of one week = 0.6)
    //   multiplier = 1 - 0.6 * 0.05 = 0.97
    //   60 * 0.97 = 58.2 → round → 58
    const score = triTrailingEffortScore(state, 'swim');
    console.log(`[P3a faster] trailing effort score = ${score}`);
    expect(score).toBeCloseTo(0.6, 5);

    const future: Workout[] = [{
      id: 'swim-future', t: 'easy', n: 'Swim', d: '2000m', r: 5,
      discipline: 'swim', estimatedDurationMin: 60,
    } as Workout];
    applyTriEffortMultipliers(state, future);
    const result = future[0].estimatedDurationMin!;
    console.log(`[P3a faster] future swim duration: 60 → ${result} min (expected < 60)`);
    expect(result).toBeLessThan(60);
    expect(result).toBe(58); // 60 * 0.97 = 58.2 → Math.round → 58
  });

  it('SLOWER than target (paceAdherence 1.1) → easier → multiplier > 1 → next swim LONGER', () => {
    const state = buildSwimState(1.1);
    // Manual computation:
    //   swimObjectiveDev = (1.0 - 1.1) * 10 = -1.0
    //   rpeDev = 0
    //   dev = 0 * 0.4 + (-1.0) * 0.6 = -0.6
    //   score = -0.6
    //   multiplier = 1 - (-0.6) * 0.05 = 1.03
    //   60 * 1.03 = 61.8 → round → 62
    const score = triTrailingEffortScore(state, 'swim');
    console.log(`[P3a slower] trailing effort score = ${score}`);
    expect(score).toBeCloseTo(-0.6, 5);

    const future: Workout[] = [{
      id: 'swim-future', t: 'easy', n: 'Swim', d: '2000m', r: 5,
      discipline: 'swim', estimatedDurationMin: 60,
    } as Workout];
    applyTriEffortMultipliers(state, future);
    const result = future[0].estimatedDurationMin!;
    console.log(`[P3a slower] future swim duration: 60 → ${result} min (expected > 60)`);
    expect(result).toBeGreaterThan(60);
    expect(result).toBe(62); // 60 * 1.03 = 61.8 → Math.round → 62
  });

  it('sign inversion is correct: faster swim (lower sec/100m) = HARDER, not easier', () => {
    // paceAdherence < 1.0 means actual pace is FASTER than target
    // (actual sec/100m < target sec/100m → adherence = actual/target < 1.0)
    // swimObjectiveDev = (1 - paceAdherence) * 10; at paceAdherence=0.9 → +1.0 (positive = harder)
    // This is INVERTED vs bike: bike powerAdherence > 1.0 = harder; swim paceAdherence < 1.0 = harder
    const fasterScore = triTrailingEffortScore(buildSwimState(0.9), 'swim');
    const slowerScore = triTrailingEffortScore(buildSwimState(1.1), 'swim');
    console.log(`[P3a sign-check] faster score=${fasterScore}, slower score=${slowerScore}`);
    expect(fasterScore).toBeGreaterThan(0); // harder → positive deviation
    expect(slowerScore).toBeLessThan(0);    // easier → negative deviation
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THING 2 (P3b): activity-matcher mod re-attachment
//   EXECUTED: findWorkoutForMod (real function) on reshuffled week
//   INSPECTED: activity-matcher.ts:362-384 — newDurationMin application
// ─────────────────────────────────────────────────────────────────────────────
//
// NOTE: matchAndAutoComplete itself is NOT called here — it requires Supabase
// rows, DB-side data, and DOM state unavailable in vitest. Instead:
//   1. EXECUTED: findWorkoutForMod with realistic reshuffled workouts
//   2. INSPECTED: lines 362-384 of activity-matcher.ts confirm newDurationMin is applied
//
// The key regression: before the fix, mods matched by name+day. When
// assignDefaultDays reshuffles the week, a "Tuesday" easy run becomes a
// "Wednesday" easy run and the mod (name="Easy Run", dayOfWeek=2) misses.
// After the fix: if mod.workoutId is set, it matches by id regardless of day.

interface MinimalMod {
  workoutId?: string;
  name: string;
  dayOfWeek?: number;
  newDurationMin?: number;
}

describe('THING 2 (P3b) — findWorkoutForMod id-keyed re-attachment (EXECUTED)', () => {
  it('id-keyed match survives a day reshuffle', () => {
    // Simulate: mod was written when easy-run was on dayOfWeek=2 (Tuesday)
    // After week regeneration + assignDefaultDays, same workout is now on dayOfWeek=3
    const workoutsAfterReshuffle: any[] = [
      { id: 'W5-easy-0', n: 'Easy Run', dayOfWeek: 3 },  // now Wednesday (was Tuesday)
      { id: 'W5-tempo-1', n: 'Tempo Run', dayOfWeek: 5 },
    ];
    const mod: MinimalMod = {
      workoutId: 'W5-easy-0',
      name: 'Easy Run',
      dayOfWeek: 2,            // stale day from when mod was first written
      newDurationMin: 45,
    };

    const found = findWorkoutForMod(workoutsAfterReshuffle, mod);
    console.log(`[P3b id-match] found workout id: ${found?.id} (expected W5-easy-0)`);
    expect(found).toBeDefined();
    expect(found!.id).toBe('W5-easy-0');

    // Simulate applying newDurationMin as activity-matcher.ts:377 does:
    //   if (mod.newDurationMin != null) (workout as any).estimatedDurationMin = mod.newDurationMin;
    if (mod.newDurationMin != null) (found as any).estimatedDurationMin = mod.newDurationMin;
    console.log(`[P3b id-match] estimatedDurationMin after mod apply: ${(found as any).estimatedDurationMin} (expected 45)`);
    expect((found as any).estimatedDurationMin).toBe(45);
  });

  it('name+day fallback still works when workoutId is absent (back-compat)', () => {
    const workouts: any[] = [
      { id: 'W5-easy-0', n: 'Easy Run', dayOfWeek: 2 },
      { id: 'W5-tempo-1', n: 'Tempo Run', dayOfWeek: 5 },
    ];
    const mod: MinimalMod = {
      // No workoutId — pre-fix mod format
      name: 'Easy Run',
      dayOfWeek: 2,
      newDurationMin: 50,
    };
    const found = findWorkoutForMod(workouts, mod);
    console.log(`[P3b back-compat] found id: ${found?.id}`);
    expect(found).toBeDefined();
    expect(found!.id).toBe('W5-easy-0');
  });

  it('name+day fallback FAILS after reshuffle when workoutId absent (regression case)', () => {
    // This documents the BUG the fix addressed — mod without workoutId loses attachment
    const workoutsAfterReshuffle: any[] = [
      { id: 'W5-easy-0', n: 'Easy Run', dayOfWeek: 3 },  // reshuffled to Wednesday
    ];
    const modWithoutId: MinimalMod = {
      name: 'Easy Run',
      dayOfWeek: 2,            // stale Tuesday — won't match after reshuffle
      newDurationMin: 45,
    };
    const found = findWorkoutForMod(workoutsAfterReshuffle, modWithoutId);
    console.log(`[P3b regression-case] stale day+name match: ${found?.id ?? 'NOT FOUND'} (expected NOT FOUND)`);
    expect(found).toBeUndefined();  // This is the bug case — mod gets lost
  });
});

// INSPECTION NOTE — activity-matcher.ts:362-384
// The following block (verbatim from the file) confirms newDurationMin is applied:
//
//   for (const mod of wk.workoutMods) {
//     const workout = findWorkoutForMod(wos as any[], mod);   ← uses id first
//     if (workout) {
//       ...
//       if (mod.status === 'reduced' || mod.status === 'replaced') {
//         ...
//         if (mod.newDurationMin != null) (workout as any).estimatedDurationMin = mod.newDurationMin;
//         ...
//       }
//     }
//   }
//
// CONCLUSION (INSPECTED): newDurationMin is applied unconditionally when the
// workout is found AND status is 'reduced'|'replaced'. The id-keyed lookup
// means it now survives reshuffles for mods that carry workoutId.

// ─────────────────────────────────────────────────────────────────────────────
// THING 3 (anchor-gate): FTP + CSS detrain anchor clobber fix
//   ENTIRELY TRANSCRIBED — main.ts cannot run headless (Supabase/Capacitor deps)
//   The boolean expressions are copied verbatim from main.ts and fed realistic values.
//   This is gate-logic verification, not execution of main.ts.
// ─────────────────────────────────────────────────────────────────────────────
//
// Source lines in main.ts:
//   FTP: 655–680
//   CSS: 578–601
//
// Transcribed verbatim and exercised as pure boolean arithmetic.

describe('THING 3 (anchor-gate) — FTP detrain anchor (TRANSCRIBED from main.ts:655-680)', () => {
  // Helper that mirrors the gate expressions exactly as written in main.ts
  function ftpGate(opts: {
    ftpAnchor: string | undefined;
    sourceRideISO: string | null | undefined;
    derivedFtp: number | null;
    currentFtp: number | null;
    ftpBlank: boolean;
    ftpDerivedRefresh: boolean;
    ftpUserBeaten: boolean;
  }) {
    const { ftpAnchor, sourceRideISO, derivedFtp, currentFtp, ftpBlank, ftpDerivedRefresh, ftpUserBeaten } = opts;

    // VERBATIM from main.ts:657-660
    const ftpEvidencePostAnchor =
      !ftpAnchor || (sourceRideISO != null && sourceRideISO > ftpAnchor);
    const ftpBlockedByAnchor =
      !ftpEvidencePostAnchor && derivedFtp != null && currentFtp != null && derivedFtp > currentFtp;

    // VERBATIM from main.ts:661
    const wouldUpdate =
      (ftpBlank || ftpDerivedRefresh || ftpUserBeaten) && derivedFtp != null && derivedFtp > 0 && !ftpBlockedByAnchor;

    return { ftpEvidencePostAnchor, ftpBlockedByAnchor, wouldUpdate };
  }

  it('(i) derived FTP HIGHER + source ride BEFORE anchor → BLOCKED (dock holds)', () => {
    // Scenario: user went on holiday, docked FTP at 250W.
    // A ride dated 2026-05-10 (before holiday end 2026-06-01) shows derived=280W.
    // Gate must block the raise — the pre-return ride is not evidence of recovery.
    const result = ftpGate({
      ftpAnchor: '2026-06-01',       // anchor = holiday end
      sourceRideISO: '2026-05-10',   // pre-anchor ride
      derivedFtp: 280,               // higher than docked
      currentFtp: 250,               // docked value
      ftpBlank: false,
      ftpDerivedRefresh: true,       // saved as 'derived'
      ftpUserBeaten: false,
    });
    console.log(`[P3c FTP(i)] evidencePostAnchor=${result.ftpEvidencePostAnchor} blocked=${result.ftpBlockedByAnchor} wouldUpdate=${result.wouldUpdate}`);
    expect(result.ftpEvidencePostAnchor).toBe(false);
    expect(result.ftpBlockedByAnchor).toBe(true);
    expect(result.wouldUpdate).toBe(false); // BLOCKED — dock holds ✓
  });

  it('(ii) derived FTP HIGHER + source ride AFTER anchor → ALLOWED + anchor should clear', () => {
    // A ride dated 2026-06-05 (after anchor 2026-06-01) shows 280W.
    // Gate allows it; anchor clears (caller sets ftpDetrainAnchorISO = undefined).
    const result = ftpGate({
      ftpAnchor: '2026-06-01',
      sourceRideISO: '2026-06-05',   // post-anchor ride
      derivedFtp: 280,
      currentFtp: 250,
      ftpBlank: false,
      ftpDerivedRefresh: true,
      ftpUserBeaten: false,
    });
    console.log(`[P3c FTP(ii)] evidencePostAnchor=${result.ftpEvidencePostAnchor} blocked=${result.ftpBlockedByAnchor} wouldUpdate=${result.wouldUpdate}`);
    expect(result.ftpEvidencePostAnchor).toBe(true);
    expect(result.ftpBlockedByAnchor).toBe(false);
    expect(result.wouldUpdate).toBe(true);  // ALLOWED ✓
    // Anchor clearing logic: main.ts:676 sets ftpDetrainAnchorISO = ftpEvidencePostAnchor ? undefined : existing
    // Since ftpEvidencePostAnchor=true → undefined → anchor cleared ✓
  });

  it('no anchor set → evidencePostAnchor=true → never blocked regardless of ride date', () => {
    const result = ftpGate({
      ftpAnchor: undefined,          // no dock active
      sourceRideISO: '2026-01-01',
      derivedFtp: 280,
      currentFtp: 250,
      ftpBlank: false,
      ftpDerivedRefresh: true,
      ftpUserBeaten: false,
    });
    console.log(`[P3c FTP no-anchor] evidencePostAnchor=${result.ftpEvidencePostAnchor} blocked=${result.ftpBlockedByAnchor}`);
    expect(result.ftpEvidencePostAnchor).toBe(true);  // !ftpAnchor short-circuits to true
    expect(result.ftpBlockedByAnchor).toBe(false);
  });

  it('derived FTP LOWER → anchor irrelevant, blocked=false (no raise → gate is moot)', () => {
    // ftpBlockedByAnchor checks derivedFtp > currentFtp — if derived is lower, no block.
    // (The ratchet-up rule handles this case separately in main.ts)
    const result = ftpGate({
      ftpAnchor: '2026-06-01',
      sourceRideISO: '2026-05-10',
      derivedFtp: 220,               // lower than docked
      currentFtp: 250,
      ftpBlank: false,
      ftpDerivedRefresh: true,
      ftpUserBeaten: false,
    });
    console.log(`[P3c FTP lower] blocked=${result.ftpBlockedByAnchor} (lower derived, not a raise)`);
    expect(result.ftpBlockedByAnchor).toBe(false); // gate is for raises only
  });
});

describe('THING 3 (anchor-gate) — CSS detrain anchor (TRANSCRIBED from main.ts:578-601)', () => {
  // CSS logic is symmetric but INVERTED: lower CSS = better (faster sec/100m)
  // So cssBlockedByAnchor fires when derivedCss < currentCss (an improvement)
  // while the source swim is pre-anchor.

  function cssGate(opts: {
    cssAnchor: string | undefined;
    sourceActivityISO: string | null | undefined;
    derivedCss: number | null;
    currentCss: number | null;
    cssBlank: boolean;
    cssDerivedRefresh: boolean;
    cssUserBeaten: boolean;
  }) {
    const { cssAnchor, sourceActivityISO, derivedCss, currentCss, cssBlank, cssDerivedRefresh, cssUserBeaten } = opts;

    // VERBATIM from main.ts:583-586
    const cssEvidencePostAnchor =
      !cssAnchor || (sourceActivityISO != null && sourceActivityISO > cssAnchor);
    const cssBlockedByAnchor =
      !cssEvidencePostAnchor && derivedCss != null && currentCss != null && derivedCss < currentCss;

    // VERBATIM from main.ts:587
    const wouldUpdate =
      (cssBlank || cssDerivedRefresh || cssUserBeaten) && derivedCss != null && derivedCss > 0 && !cssBlockedByAnchor;

    return { cssEvidencePostAnchor, cssBlockedByAnchor, wouldUpdate };
  }

  it('(iii) derived CSS LOWER (faster = better) + swim BEFORE anchor → BLOCKED (dock holds)', () => {
    // Docked CSS = 105 s/100m (slower, docked due to holiday detraining).
    // A swim dated before the anchor shows derived=98 s/100m (faster = improvement).
    // Gate must block — pre-return swim is not evidence of recovery.
    const result = cssGate({
      cssAnchor: '2026-06-01',
      sourceActivityISO: '2026-05-15', // pre-anchor swim
      derivedCss: 98,                  // lower = faster = improvement
      currentCss: 105,                 // docked value
      cssBlank: false,
      cssDerivedRefresh: false,
      cssUserBeaten: true,             // would be user-beaten without the anchor
    });
    console.log(`[P3c CSS(iii)] evidencePostAnchor=${result.cssEvidencePostAnchor} blocked=${result.cssBlockedByAnchor} wouldUpdate=${result.wouldUpdate}`);
    expect(result.cssEvidencePostAnchor).toBe(false);
    expect(result.cssBlockedByAnchor).toBe(true);
    expect(result.wouldUpdate).toBe(false); // BLOCKED — dock holds ✓
  });

  it('derived CSS LOWER + swim AFTER anchor → ALLOWED + anchor cleared', () => {
    const result = cssGate({
      cssAnchor: '2026-06-01',
      sourceActivityISO: '2026-06-08', // post-anchor swim
      derivedCss: 98,
      currentCss: 105,
      cssBlank: false,
      cssDerivedRefresh: false,
      cssUserBeaten: true,
    });
    console.log(`[P3c CSS post-anchor] evidencePostAnchor=${result.cssEvidencePostAnchor} blocked=${result.cssBlockedByAnchor} wouldUpdate=${result.wouldUpdate}`);
    expect(result.cssEvidencePostAnchor).toBe(true);
    expect(result.cssBlockedByAnchor).toBe(false);
    expect(result.wouldUpdate).toBe(true); // ALLOWED ✓
  });

  it('CSS HIGHER (slower = worse) pre-anchor → blocked=false (worsening never blocked by gate)', () => {
    // If CSS increased (got worse), the anchor gate doesn't trigger (gate checks derivedCss < currentCss).
    // A worsening of CSS is a separate concern (ratchet rule, not anchor).
    const result = cssGate({
      cssAnchor: '2026-06-01',
      sourceActivityISO: '2026-05-15',
      derivedCss: 112,               // higher = slower = worse
      currentCss: 105,
      cssBlank: false,
      cssDerivedRefresh: true,
      cssUserBeaten: false,
    });
    console.log(`[P3c CSS worse] blocked=${result.cssBlockedByAnchor} (worsening, gate moot)`);
    expect(result.cssBlockedByAnchor).toBe(false); // no false-positive block on worsening
  });

  it('CSS anchor boundary: ride ISO equal to anchor ISO → NOT post-anchor (strict greater-than)', () => {
    // main.ts uses sourceRideISO > anchorISO (strict). A swim on exactly the anchor date
    // is still pre-anchor (the user returned that day but hasn't trained post-return).
    const result = cssGate({
      cssAnchor: '2026-06-01',
      sourceActivityISO: '2026-06-01', // exact match — must be treated as pre-anchor
      derivedCss: 98,
      currentCss: 105,
      cssBlank: false,
      cssDerivedRefresh: false,
      cssUserBeaten: true,
    });
    console.log(`[P3c CSS boundary] evidencePostAnchor=${result.cssEvidencePostAnchor} (exact date, strict GT)`);
    // '2026-06-01' > '2026-06-01' is false → cssEvidencePostAnchor = false → blocked
    expect(result.cssEvidencePostAnchor).toBe(false);
    expect(result.cssBlockedByAnchor).toBe(true);
  });

  it('FTP anchor boundary: ride ISO equal to anchor ISO → NOT post-anchor (strict greater-than)', () => {
    // Same boundary check for FTP path (main.ts:658 also uses strict >)
    const ftpAnchor = '2026-06-01';
    const sourceRideISO = '2026-06-01';  // exact match
    // VERBATIM from main.ts:657-658
    const ftpEvidencePostAnchor =
      !ftpAnchor || (sourceRideISO != null && sourceRideISO > ftpAnchor);
    console.log(`[P3c FTP boundary] evidencePostAnchor=${ftpEvidencePostAnchor} (exact date, should be false)`);
    expect(ftpEvidencePostAnchor).toBe(false);
  });
});
