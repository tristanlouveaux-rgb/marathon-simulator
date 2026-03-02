# Gym Programme Build — Implementation Log

## Status: IN PROGRESS

## What We're Building
Running-focused gym sessions as a first-class workout type. Optional at onboarding, phase-aware, ability-aware, injury-aware. Full exercise prescriptions (sets/reps/exercises with form cues for beginners).

## Hard Guardrails
- NO redesign of load engine, cross-training engine, or injury logic
- Strength is additive, NEVER replaces running
- NO complex physiological models
- Minimal diffs only — add scaffolding, hooks, scheduling
- Gym adapts by phase/block, not micromanaged daily

## Key Design Decisions
1. **Type**: `t: 'gym'` (distinct from injury engine's `t: 'strength'` for rehab)
2. **Max sessions**: 0-3 per week (research-backed optimal range)
3. **Descriptions**: Full prescription with exercises/sets/reps. Beginners get brief form cues.
4. **Phase scaling**: Base=max sessions, Build=reduced, Peak/Taper=minimal
5. **Injury**: No changes to injury engine — existing phase replacement handles gym automatically
6. **Load profile**: Anaerobic-heavy (0.20 aerobic / 0.80 anaerobic)
7. **Scheduling**: Gym treated like cross-training in scheduler — placed after runs, avoids hard days

## Science Source
All science from `Strength Training.txt` in project root. Key points:
- Heavy resistance (>=80% 1RM) + plyometrics improve running economy 2-4%
- 2-3 sessions/week for 8-12+ weeks is optimal
- Session timing: >=9-24h separation from hard runs
- Base phase: heavy compound lifts (foundation)
- Build phase: power/plyometrics (conversion)
- Peak/Taper: maintenance only (preserve, don't gain)

---

## Implementation Steps

### Step 1: Data Model (types)
**Files**: `src/types/onboarding.ts`, `src/types/state.ts`

- Add `gymSessionsPerWeek: number` to `OnboardingState` (after `runsPerWeek`, default 0)
- Add `gs?: number` to `SimulatorState` (after `rw: number`)
- No changes to Workout interface (Workout.t is already `string`)

### Step 2: Volume UI
**File**: `src/ui/wizard/steps/volume.ts`

Insert gym sessions selector between "Runs per week" and "Other sports":
```
Runs per week           [1] [2] [3] [4] [5] [6] [7]
Gym sessions per week   [0] [1] [2] [3]          <-- NEW
Other sports per week   [0] [1] [2] [3] [4] [5]
```
- Same button style as existing runs/sports
- Recommendation text:
  - 0: "No gym — that's fine, running is king"
  - 1: "Good maintenance dose for any runner"
  - 2: "Recommended for most training plans"
  - 3: "Optimal for base phase; auto-reduces in taper"
- Wire `data-gym` buttons to `updateOnboarding({ gymSessionsPerWeek: n })`

### Step 3: State Initialization
**File**: `src/state/initialization.ts`

After `s.rw = runsPerWeek;` (line ~121), add:
```ts
s.gs = state.gymSessionsPerWeek || 0;
```

### Step 4: Gym Session Generator (NEW FILE)
**File**: `src/workouts/gym.ts` (~150 lines)

Single exported function:
```ts
export function generateGymWorkouts(
  phase: TrainingPhase,
  gymSessionsPerWeek: number,
  fitnessLevel: string,
  weekIndex?: number,
  totalWeeks?: number,
  vdot?: number,
  injuryState?: InjuryState | null
): Workout[]
```

#### Phase Templates (Full Prescription)

**BASE** — Foundation/Hypertrophy (heavy, compound). RPE 6-7, ~45min:
- Session A: "Heavy Lower Body — 3x5 Back Squat @80%, 3x8 Romanian Deadlift, 3x10 Hip Thrust, 3x45s Front Plank"
- Session B: "Unilateral & Core — 3x8 Bulgarian Split Squat (each), 3x10 Step-Ups, 3x15 Banded Clamshells, 3x10 Pallof Press"
- Session C: "Posterior Chain — 3x5 Deadlift @80%, 3x10 Single-Leg RDL, 4x12 Calf Raises, 3x10 Nordic Curl (assisted)"

**BUILD** — Power/Plyometrics. RPE 6-7, ~40min:
- Session A: "Power & Plyometrics — 4x3 Jump Squat, 3x5 Front Squat @85%, 3x5 Single-Leg Bounds (each), 3x8 Glute Bridge"
- Session B: "Explosive Strength — 3x5 Trap-Bar Deadlift @85%, 3x5 Box Jumps, 3x8 Weighted Lunges, 2x30s Side Plank (each)"

**PEAK** — Maintenance. RPE 5, ~30min:
- Session A: "Maintenance — 2x5 Squat @75%, 2x5 Deadlift @75%, 2x8 Lunges, 2x15 Calf Raises"

**TAPER** — Neuromuscular only. RPE 4, ~25min:
- Session A: "Activation — 2x5 Jump Squat (bodyweight), 2x5 Trap-Bar Deadlift @70%, 2x8 Lunges, Short core circuit"

#### Session Count Scaling
```
User selected | Base | Build | Peak | Taper
3             | 3    | 2     | 1    | 1
2             | 2    | 2     | 1    | 1
1             | 1    | 1     | 1    | 0-1
```

#### Ability Scaling
- **total_beginner / beginner**: Bodyweight, lower RPE, form cues
  - e.g. "Bodyweight Foundation — 3x10 Bodyweight Squat (slow, full depth), 3x10 Glute Bridge (squeeze at top), 3x10 Reverse Lunge each leg (steady), 3x30s Plank (flat back)"
- **novice**: Light loaded, standard exercises
- **intermediate+**: Full prescriptions as above
- **returning**: Same as novice (conservative ramp)
- **hybrid**: Full prescriptions (strength emphasized)

#### Deload Weeks
Reuse `isDeloadWeek(weekIndex, ability)` from `plan_engine.ts`:
- Reduce session count by 1 (min 0)
- Reduce RPE by 1
- Append "(Deload)" to workout name

#### Injury Guard
Check injuryState before generating:
- `acute` → return [] (no gym)
- `rehab` → return [] (injury engine injects rehab strength)
- `test_capacity` → return [] (testing only)
- `return_to_run` level 1-4 → return []
- `return_to_run` level 5-8 → 1 light session
- `resolved` or no injury → normal generation

### Step 5: Generator Integration
**File**: `src/workouts/generator.ts`

- Import `generateGymWorkouts` from `./gym`
- Add `gymSessionsPerWeek?: number` as final optional parameter
- After commute runs (~line 153), before recurring cross-training (~line 155):
```ts
if (gymSessionsPerWeek && gymSessionsPerWeek > 0) {
  const gymWorkouts = generateGymWorkouts(
    phase, gymSessionsPerWeek, fitnessLevel || 'intermediate',
    weekIndex, totalWeeks, vdot, injuryState
  );
  workouts.push(...gymWorkouts);
}
```

### Step 6: Load Profile
**File**: `src/constants/workouts.ts`

Add to LOAD_PROFILES:
```ts
'gym': { aerobic: 0.20, anaerobic: 0.80 },
```

### Step 7: Scheduler
**File**: `src/workouts/scheduler.ts`

- Add `'gym'` to `CROSS_TYPES` array (line 13)
- Update `movePriority`: gym = 3.5 (between cross=4 and easy=3)

### Step 8: Total Km Counter
**File**: `src/ui/main-view.ts`

In `computeTotalKm`, add `'gym'` to the type exclusion filter.

### Step 9: Update Call Sites
Pass `s.gs` as final argument to all 7 production `generateWeekWorkouts` calls:

| File | Line | Context |
|------|------|---------|
| `src/ui/main-view.ts` | ~131 | computeTotalKm loop |
| `src/ui/main-view.ts` | ~1111 | main week render |
| `src/ui/renderer.ts` | ~161 | week workout rendering |
| `src/ui/renderer.ts` | ~714 | workout matching |
| `src/ui/events.ts` | ~534 | complete week |
| `src/ui/events.ts` | ~550 | next week preview |
| `src/ui/events.ts` | ~1092 | activity logging |
| `src/ui/events.ts` | ~1741 | week workouts |

Since param is optional, test files don't need changes.

---

## What We're NOT Doing
1. No new fatigue model — gym uses existing `calculateWorkoutLoad`
2. No exercise picker/tracker — pre-prescribed templates
3. No gym-specific progression tracking — no 1RM tracking, no set/rep logging
4. No changes to run generation — gym is additive
5. No changes to cross-training engine — gym is separate
6. No changes to injury engine — phase replacement handles gym automatically
7. No changes to race predictions — gym doesn't affect VDOT
8. No changes to load engine internals — just a new load profile entry

## Verification Checklist
- [ ] `npx tsc --noEmit` — no new errors
- [ ] Volume page: gym selector appears, saves to state
- [ ] Dashboard: gym workouts appear for users with gs > 0
- [ ] Phase behavior: base shows 2-3 sessions, taper shows 0-1
- [ ] Injury: report injury → gym workouts disappear
- [ ] Scheduling: gym on non-hard-run days, no stacking
- [ ] Load tracker: gym shows anaerobic-heavy load
- [ ] Total km: gym excluded from distance counter
