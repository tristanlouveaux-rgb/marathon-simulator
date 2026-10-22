# HYROX equipment swaps: recommended design (2026-10-22)

Status: design only, nothing built. Synthesised from two designs (session-first, scored 8 and 8; generator-first, scored 6.5 and 6) and two reviews. Base: the session-first design. Grafted from the generator-first design: the carry runs once after the whole plan is built, run substitutes are held to the run capacity, the real-kit helper name, and the version bump. Claims both reviews proved wrong are dropped (listed at the end of section 4).

Source research: `docs/research/hyrox-equipment-substitutions-2026-10.md` (cited below as "research §n"; source numbers [n] and evidence labels [E] [C] [S] [I] are that document's).

**Line references.** These point at the lane-h2b working tree (`/Users/tristanlouveaux/Documents/mosaic-wt/lane-h2b`) as of 2026-10-22. That tree has uncommitted edits right now (+353/-790 across three files). Most of it is in `plan_engine.hyrox.ts`, which rewrites the injury gate into `stationSession` with a per-set `ownCap`. `hyrox-generators.ts` folds the partial-set helpers into `withHyroxPartialSets`. Build this only after fix/hyrox-h2b merges. Re-derive every line from the merged tree. Dump a /tmp patch before touching `src/types/triathlon.ts`, `src/types/state.ts` or `plan_engine.hyrox.ts` (CLAUDE.md multi-agent rule).

**Founder decisions honoured (settled):**
- Setup stays as it is.
- Plans always prescribe the real stations and never drop one.
- A "sometimes" sled is prescribed as a real sled.
- A swap applies to this session only.
- Doses are time- and effort-matched; distance or rep matching is used only for the same task.
- A substitute counts toward its station's forecast.
- Treadmill sled push only on curved manual treadmills.
- The `mtlFactor` table is retired.
- Planned TSS is inherited, and actuals win.
- No new reads of the HYROX results tables (ISSUE-404).

---

## 1. What the athlete sees

- **All eight stations, every plan.** An athlete whose setup says no sled still gets Sled Push and Sled Pull in the rotation, the bricks and the race sims.
- **No kit: the station shows its stand-in.** The row still reads "Sled Push". Under it, one muted line gives the stand-in and the dose: "Plate push, 4 × about 1:02 at RPE 5". A second muted line says why: "No sled in your setup."
- **Swap, per session.** Each station row has a muted "Swap" text button ("Change swap" when one is active).
  - It switches the same window to a list: the station itself first, then the alternatives. Each shows this session's dose and the kit it needs.
  - Tapping one changes that session only. Other sessions, other weeks and the plan stay as they were.
- **Same time, same effort.** A stand-in runs for the station's planned set time at the session's effort. Session length and planned load do not move.
- **Forecast and records.**
  - A stand-in counts toward that station's forecast.
  - It never sets a station best or a percentile. The finish screen says "Done as a plate push. No station time recorded."
- **Injury.**
  - Options that would load an injured side harder than the station are hidden, with one muted line: "Some swaps are hidden while lower-body capacity is 40%."
  - A stand-in run under a run restriction moves to the air bike, with a week note in the gate's existing style.
- **Week-1 assessment.** It tests only stations the athlete has the kit for, and names the ones it leaves out.
- **Setup screen.** Unchanged (sled: have access / no access; SkiErg; RowErg).

---

## 2. Data model and the one resolver

### 2.1 Component overlay (`src/types/triathlon.ts`, `HyroxComponent` :268-301)

```ts
/** What this station component is done as (equipment swap). The component
 *  still prescribes the station: type, distanceM/reps, durationSec, loadKg,
 *  raceFraction and inRounds stay the station's. Absent: the real station. */
sub?: HyroxComponentSub;

export interface HyroxComponentSub {
  /** Catalogue id, or null: the athlete chose the real station over the
   *  plan's default for this session (only with by 'user'). */
  id: HyroxSubstituteId | null;
  /** 'default': stamped by the generator (no kit in stationAccess), or
   *  re-picked by the injury gate. 'user': this session's swap. */
  by: 'default' | 'user';
  /** This component's MTL as the substitute ÷ its MTL as the station, both
   *  from computeComponentMTL rows (section 6.2). 1 for id null. */
  mtlRatio: number;
}
```

Why it lives on the component:
- A session holds a station at most once (`withoutHyroxStation` uses `findIndex`, hyrox-generators.ts:462). So per-component equals per-session.
- Every cut spreads the component, so `sub` rides through `withHyroxRounds` :411, `withHyroxPartialSets` :515 and `withoutHyroxStation` :459. Those cuts scale `c.mtl` linearly, and the ratio does not depend on scale, so the substitute's MTL stays right after any cut.

The field is optional, so fresh installs need no migration.

### 2.2 Retired fields

- `Workout.hyroxStationSubs` and `Workout.hyroxOriginalMtls` (`src/types/state.ts:207`, `:210`) are deleted, together with their only reader, `workout-detail-modal.ts`.
- The v20 regen replaces `triWorkouts` in every stored week (`hyrox-plan-regen.ts:296` loops over all weeks). One `console.log` counts the legacy swaps it drops.
- A revert needs no snapshot: it is `c.mtl / sub.mtlRatio`.

### 2.3 Catalogue (`src/constants/hyrox-station-substitutes.ts`, new; replaces `src/constants/hyrox-substitutions.ts`)

```ts
export type HyroxSubDose = 'amount' | 'time';
export interface HyroxStationSubstitute {
  id: HyroxSubstituteId;
  station: HyroxStation;
  name: string;                       // "Plate push"
  dose: HyroxSubDose;                 // 'amount' only when sameTask (founder rule)
  sameTask: boolean;
  mtlRow: HyroxStation | 'run';       // an existing STATION_MTL_FACTORS key, or 'run'
  externalLoad: 'station' | 'none';   // 'station' only when sameTask
  requires?: 'skiErg' | 'rowErg';     // kit the setup already asks about
  needs: string;                      // muted picker line: "Needs a cable machine."
  cue: string;                        // guided cue: "Same effort as the sled set."
  sources: string[];                  // research source ids: ['[2]','[16]','[10]']
}
export const HYROX_STATION_SUBSTITUTES: readonly HyroxStationSubstitute[];  // research rank order
export const HYROX_DEFAULT_SUBSTITUTE: Record<'ski_erg'|'row_erg'|'sled_push'|'sled_pull', readonly HyroxSubstituteId[]>; // founder call 1
```

The catalogue has no numeric fields. A test pins that: the string `mtlFactor` must appear nowhere in `src/`.

### 2.4 The resolver (`src/workouts/hyrox-substitution.ts`, new, pure)

It imports `mtl.ts`, the constants, `hyrox-benchmarks.ts` and `hyrox-injury.ts`. It imports nothing from the generators, so there is no cycle. It also imports nothing from `hyrox-population` or any results-table module; an anchor test pins this for ISSUE-404.

| Function | Rule |
|---|---|
| `hyroxHasKit(st, access)` | The one equipment rule. It is the body of today's `availableStations` (hyrox-generators.ts:163-171) and `hyroxTestableStations` (hyrox-station-history.ts:223-231). `'sometimes'` counts as kit. |
| `hyroxRealKitStations(access)` | `HYROX_STATION_ORDER.filter(hyroxHasKit)`. It feeds the warm-up, finisher, easy erg sessions, the assessment and `hyroxTestableStations`. |
| `hyroxDefaultSubstitute(st, access)` | Null when the athlete has the kit (so `'sometimes'` and `'always'` get no default). Otherwise the first id in `HYROX_DEFAULT_SUBSTITUTE[st]` whose `requires` the athlete has. It reads no injury input. |
| `hyroxSubstituteOptions(st, { access, caps? })` | Catalogue rows for the station in rank order, minus any whose `requires` is missing. With caps, minus rows where `hyroxModeCapacity(row) < hyroxModeCapacity(st)`. |
| `hyroxSubMtlRatio(subId, c, rpe, bw)` | `computeComponentMTL(1, rpe, row(sub, rpe), ext(sub, c), bw) / computeComponentMTL(1, rpe, st, ext(st, c), bw)`. |
| `row(sub, rpe)` | The catalogue row, or for `'run'`: `rpe <= HYROX_EASY_RPE ? 'run_easy' : 'run_tempo'` (the brick run-leg precedent, hyrox-generators.ts:1245). |
| `ext(st, c)` | The station's rule from `stationComponent` (:1012-1016): sleds `loadKg × SLED_EXTERNAL_LOAD_FRACTION`, others `loadKg`. For a substitute: `'station'` uses the same; `'none'` uses undefined. |
| `resolveHyroxComponent(w, c)` | Returns `{ station, stationName, sub, by, doName, target, rowText, countsTowardStation, teachesBenchmark, keepsStationLoad }`. `target` is `{ kind: 'amount' }` (station amount and load) or `{ kind: 'time', sec: c.durationSec, rpe: w.rpe }`. |
| `countsTowardStation` | True for no substitute and for every catalogue row, since each is time- and effort-matched or the same task. This is the founder rule. |
| `teachesBenchmark` | `!sub || sub.id === null`. |
| `keepsStationLoad` | `!sub || sub.id === null || externalLoad === 'station'`. |
| `hyroxStationTrainable(st, access)` | `hyroxHasKit || countsTowardStation(default)`. A test pins that it is true for all 8 stations under every access combination. |

`hyroxModeCapacity(mode, { run, upper, lower })` moves into `src/calculations/hyrox-injury.ts`, extracted from the gate's `ownCap` (plan_engine.hyrox.ts:2739-2743):
- `'run'`: the run capacity.
- A station row: `HYROX_STATION_REGION` (:36-45), where `full` means `min(upper, lower)`.

The gate, the resolver and the swap view all call it.

`withHyroxStationSub(w, station, choice, by, ctx)` lives in `hyrox-generators.ts` next to `withHyroxRounds`, because it needs the private `finishHyroxSession` (:869).
- `choice`: a catalogue id, `'station'` or `'plan'`.
- `ctx`: `{ access, bodyWeightKg }`.
- The base MTL is `c.sub ? c.mtl / c.sub.mtlRatio : c.mtl`.
- `'plan'` restores the generator's default, or no substitute when there is none.
- `'station'` sets `{ id: null, by: 'user', mtlRatio: 1 }` when a default exists. Otherwise it removes `sub`.
- An id sets `{ id, by, mtlRatio: newRatio }` and `c.mtl = base × newRatio`.
- Picking the plan's own default collapses to `'plan'`.
- It never touches `durationSec`, the amount or the load. It ends with `finishHyroxSession`, so MTL, duration and text come from one place.

---

## 3. Substitution table

**Dose rules**
- **Time**: the set's own `durationSec` (the athlete's benchmark or band seed via `stationSeedSec` :222, times the set fraction) at the session RPE, with the original rests.
- **Amount**: the station's distance or reps at the station's prescribed load. Used only for the same task.

**Columns**
- **MTL row**: an existing row (hyrox-constants.ts:256-273), mapped per research §5.2.
- **Ext**: the external load inside the MTL formula.
- **v1**: held-out rows have no research MTL row (founder call 2).

**The station itself.** A real sled on any surface, a race-weight dumbbell or kettlebell carry, and a med ball to a marked height on any permitted wall are the station itself (research §5.3). They are not catalogue rows. In the swap view they sit in the first row, "Use the station". That row gets one muted line of advice, for example "Any sled on turf or floor. Load it by posture." [E] friction [22], [C] [9][44].

### SkiErg (default only when skiErg = no)

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| RowErg | requires rowErg | Time | row_erg | none | no | [C] [7][28] | yes, default 1 |
| Air bike, arms and legs | air bike | Time | row_erg | none | no | [S] [7] | yes |
| BikeErg | BikeErg | Time (the Concept2 half-metre rule is accounting only) | row_erg | none | no | [S]+[E] caveat [28][29][23] | yes |
| Run or brisk incline walk at station effort | none | Time | run by RPE | none | no | [S] [7] | yes, default 2 |
| DB/KB snatches, KB swings, med-ball slams, band pulldowns, burpees | | | no row | | | [S]/[C] [10][15][12][7][32] | held out |

Excluded: the straight-arm cable pulldown (strength support, research §1 tier 3).

### RowErg (default only when rowErg = no)

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| SkiErg | requires skiErg | Time | ski_erg | none | no | [C] [7][28] | yes, default 1 |
| Air bike | air bike | Time | row_erg | none | no | [S] [7] | yes |
| BikeErg | BikeErg | Time | row_erg | none | no | [S]+[E] [23][28] | yes |
| Run at station effort | none | Time | run by RPE | none | no | [S] [7] | yes, default 2 |
| KB swings, DB deadlift-to-row, inverted rows | | | no row | | | [S] [10] | held out |

### Sled Push (default only when sled = no access; "sometimes" prescribes the real sled)

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| Plate push on a towel or turf | plates | Time | sled_push | none | no | [C] [2][16][10] | yes, recommended default |
| Curved manual treadmill with a sled or resistance mode (Woodway Curve FTG, Technogym SkillMill, REP Strive) | that treadmill | Time, one effort per lane set | sled_push | none (a resistance level is not a mass) | no | [S]+[I] [17][18][19][20] | yes |
| Hill or steep incline run at station effort | a hill or treadmill incline | Time | run by RPE | none | no | [C] [9][2][16] | yes |
| DB/KB floor push, goblet walks, wall drives, low marches, bear crawls | | | no row | | | [S]/[C] [2][10][15][9][13] | held out |

Notes:
- The hill row drops the research's "6-10 × 15-30 m" sprint dose, because the founder rule is time-matched. Its copy says "at station effort", so it never promises a sprint at RPE 5.
- Excluded: the switched-off motorised treadmill (founder; [6] warns against it), car or partner pushes (research "not in app"), and leg press, squats and split squats (strength support).

### Sled Pull (default only when sled = no access)

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| Cable-stack rope pull: hand over hand or seated, plus backward walks under cable tension | cable machine | Time | sled_pull | none | no | [C] [10][11][14] | yes, recommended default |
| Rope looped round a loaded plate, pulled hand over hand | plate and rope | Time | sled_pull | none | no | [S] [11] | yes |
| Band rows and backward band walks, backpack backward walks, towel rows, inverted rows | | | no row | | | [C]/[S]/[I] [13][11][14][12][10] | held out |

Excluded: rows, deadlifts and rope pull-ups (strength support).

### Burpee Broad Jumps

No swap control. The station needs only floor space; coaches say train the movement directly ([C] [10][11][12]). Shuttling out and back is the station.

### Farmers Carry (prescribed real; there is no setup question)

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| Trap-bar carry at the matching total load | trap bar | Amount | farmer_carry | station | yes | [C] [10] | yes |
| The pair you own, lighter than race weight | dumbbells or kettlebells | Time | farmer_carry | none | no | [C] swap, [I] dose [13][12] | yes |
| Loaded bags, backpacks or water containers | none | Time | farmer_carry | none | no | [C] [10][12][13] | yes |

### Sandbag Lunges

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| Barbell back-rack walking lunges at race load (a 20 kg bar is the men's Open bag) | barbell | Amount | sandbag_lunges | station | yes | [C]+[I] [10][11] | yes |
| Front-rack dumbbell walking lunges at race load in total | dumbbells | Amount | sandbag_lunges | station | yes | [C] [10][11] | yes |
| Weighted-vest walking lunges at race load | vest | Amount | sandbag_lunges | station | yes (research §5.3: a race-load lunge with any implement) | [S] [10] | yes |
| Goblet lunges at the load you own | dumbbell or kettlebell | Time | sandbag_lunges | none | no | [C] [10][11] | yes |
| Bodyweight or backpack walking lunges | none | Time (founder rule overrides the research's distance match) | sandbag_lunges | none | no | [C] [12][13] | yes |

### Wall Balls

| Substitute | Kit | Dose | MTL row | Ext | Same task | Evidence | v1 |
|---|---|---|---|---|---|---|---|
| Dumbbell or barbell thrusters | dumbbells or barbell | Time (no published ball-to-thruster conversion) | wall_balls | none | no | [C] [42][10][15] | yes |
| Goblet squat to press | dumbbell or kettlebell | Time | wall_balls | none | no | [C] [12][10][15] | yes |
| Air squats with an overhead reach | | | no row | | | [S]+[I] [15] | held out |

### Defaults under an injury (gate only)

The generator stamps defaults from `stationAccess` alone. Under an active injury, the gate re-picks each **default** (never a user swap) whose own capacity is below the station's. The new choice is the allowed option with the highest capacity among those whose MTL rate (modality × impact of its row) is no higher than the default's. Ties go by catalogue rank. This is `gatedWarmup`'s rule: "the way with the highest capacity" (plan_engine.hyrox.ts:2779-2801).

Worked case: no ergs and a run restriction. The SkiErg's run default moves to the air bike (row_erg row, rate 0.35 against 0.8), whose capacity is `min(upper, lower)`. A re-pick never raises MTL.

---

## 4. Generator changes

All in `src/workouts/hyrox-generators.ts` unless noted.

1. **No station is ever dropped.**
   - Delete `availableStations` (:163-171).
   - `pickStations` (:178-203) draws from `HYROX_STATION_ORDER`. Delete the empty-pool fallback at :186. The base-phase eccentric ordering is unchanged.
   - The race-pace weakest check (:1118-1119) and `generateHyroxSim` (:1344-1348) use all stations. Delete the sim's "left out" doc line.
   - A full-kit athlete gets byte-identical output apart from the version. A test pins this.
2. **Default stamping.**
   - `stationComponent` (:1000-1031) takes `{ access, bodyWeightKg }` and builds the station component as today.
   - When `hyroxDefaultSubstitute` returns an id, it sets `c.sub = { id, by: 'default', mtlRatio }` and `c.mtl ×= mtlRatio`.
   - The sim's inline components (:1370-1390) do the same.
3. **Pools that pair a station with running, or exist to keep the taper light, never take a run-substituted station.**
   - A run standing in for an erg inside a brick turns the brick into continuous running.
   - A new `hyroxRunFreeStations(access)` returns stations with the kit, or whose default is not a `'run'` row.
   - It feeds the main and secondary brick pools in `brickStations` (:1188-1207) and `raceWeekCircuitStations` (:211-213).
   - The taper mini-brick keeps the real-kit ergs, else the farmers carry, as today.
   - Effect: sleds on plate push or cable pull do enter main bricks. A no-erg athlete's race week stays the easy run it is today (the `MIN_CIRCUIT_STATIONS` gates at plan_engine.hyrox.ts:1305 and :1579 are unchanged in effect for them).
   - No station is dropped from the plan: the excluded ergs still rotate through station sessions and sims.
4. **Real-kit only, unchanged in behaviour:** `easyErgStations` (:596-599), `hyroxEasyErgMtlPerMin`, `generateHyroxEasyErg`, `hyroxSessionWarmup`, `withHyroxFinisher` and the gate's warm-up `has`. They switch to `hyroxRealKitStations`.
5. **Assessment** (:1447).
   - It stays real-kit, because a substitute records no station time and so cannot calibrate.
   - It adds one sentence naming what it leaves out: "Sled Push and Sled Pull are left out of this test: no sled in your setup. They train with a stand-in."
6. **Load cap rebuild.** `withHyroxStationLoads` (:565-594) recomputes a lowered component's MTL from the station row (:585). With `c.sub` set, it multiplies by `hyroxSubMtlRatio` at the new load and stores that ratio. For a `'none'` substitute the product does not depend on the sled kg, which is correct.
7. **Text, one source.**
   - `stationPrescription` and `loadPhrase` (~:717-745) read `resolveHyroxComponent`. A time-dosed substitute always shows its time, technique sessions included, because time is its dose: "Sled Push: 4 × plate push, about 1:02 a set at RPE 5."
   - `hyroxSessionText`, `hyroxStationRowText` (the card, workout-card.ts:58) and the description all follow.
   - No extra session note: the row's own line says why.
8. **`withHyroxStationSub`** (section 2.4) and **`carryHyroxSessionSubs`** (section 4.11).
9. **Injury gate** (plan_engine.hyrox.ts `hyroxInjuryGate`, `stationSession` :2822-2862).
   - First, at the top of `stationSession`, before the `off` check, re-pick defaults (section 3, last part) and note any move ("Run capacity 40%: air bike in place of the run for the SkiErg.").
   - Then the effective capacity of a component is `min(ownCap(station), hyroxModeCapacity(sub row))`. A session-scoped lookup by station works, because a session holds a station once.
   - The `off` check (:2824) and the partial-set share (`withHyroxPartialSets(w0, st => effCap(st) / 100)`, :2826) both read that effective capacity.
   - An unsubstituted component reads exactly what it reads today, so only substituted components change.
   - The gate stays sized on the station's own region. The substitute can only lower it.
   - Bricks and sims are still dropped under any restriction (:2735).
10. **Beginner load memory** (`rememberLoads` :3696-3706, and the load-step notes).
    - Skip a component when either the fresh component or the stored session (`state.wks[d.week-1].triWorkouts` by `x.id`) has `keepsStationLoad` false.
    - Otherwise an easy rating of a plate-push session would step the sled load.
11. **Carry user swaps through plan-keeping rebuilds, once, after the whole plan is built.**
    - `carryHyroxSessionSubs(storedWeek, freshWorkouts, ctx)` takes each stored component whose sub has `by: 'user'`. It finds the fresh session with the same id (`W{week}-{t}-{idx}`, stamped at :2643) and the same `t`, still holding the station.
    - It re-applies the swap through `withHyroxStationSub` when the option is still allowed: kit still there, and capacity at least the station's under the current caps. Otherwise it drops the swap: with a week note when an injury caused it ("Plate push swap removed: lower-body capacity 30%."), silently otherwise.
    - It runs only after every week is built, never inside `generateWeekSessions`. Deload and taper weeks copy their reference sessions (`repeatRef` :1440-1518), so a swap can never leak into a copy.
    - Wiring:
      - `regenerateHyroxWeeksFrom` (:5366) carries internally from `existing`. That covers the injury rebuild (injury/modal.ts:504-506).
      - `generateHyroxPlan(state, { keepSessionSwaps: true })` carries from `state.wks` before callers replace it. Only the plan-keeping callers pass the flag: the version regen (hyrox-plan-regen.ts:294) and the rollover rebake (events.ts:843).
      - New-plan rebuilds do not pass it, so they drop swaps as they drop `rated`: initialization.hyrox.ts:410 and :415, hyrox-prev-time-update.ts:123, hyrox-prev-format-fix.ts:138.
12. **Version.**
    - `HYROX_GENERATOR_VERSION` goes from 19 to 20 (plan_engine.hyrox.ts:480), with a comment block in the style of the v19 one.
    - Bump rather than fold into v19: v19 plans may already be stored on the founder's device (memory: generator-version-bump trap).
    - Limited-kit athletes see sleds or ergs return, sims at full length, forecasts move. That goes in the CHANGELOG.

**Unchanged by design**
- The scheduler's eccentric 48 h rule, the hard-session cap and the race-week exclusions all key on station identity, which is the conservative choice.
- `hyroxStationToCut` ranks by `c.mtl`, which is now the substitute's real MTL.
- Memo keys are unchanged, because access is constant within one build.

**Dropped claims (proven wrong in review)**
- "A run default under run capacity 0 is left to the gate." The gate never reads the run capacity for station components.
- "At 0 it is cut with `withoutHyroxStation`." It refuses at `MIN_CIRCUIT_STATIONS` or fewer (:464).
- "Swap then revert is deep-equal" under a full recompute. `durationSec` rounding and the partial-set floor break it; the stored ratio does not.
- Re-keying the gate's region lookups to the substitute's region, and passing the run capacity into the generators. The first breaks the uninjured-reference comparison; the second also lets an upper-body station bank forecast weeks from running.
- Swaps on future weeks. Future cards cannot be tapped (plan-view.ts:320); see founder call 3.
- Hill sprints as the sled push default, dosed at RPE 5 on a tempo row.
- Vest lunges at race load dosed by time with no load.
- A burpee plus separate broad jump as a same-task row.

---

## 5. Swap UI

**UI pre-flight (CLAUDE.md)**
1. UX_PATTERNS read: Visual Constraints :9, Overlays and Modals :166, Buttons :194-260.
2. Copy rules read.
3. Pattern modelled: the strength exercise swap.
   - The muted text button under the row (`strength-workout-detail-modal.ts:131-133`).
   - The in-modal `mode` switch (:234).
   - `renderSwapOptions` rows with a 3 px stripe and a revert row first (:162-179).
4. Visual constraints: neutrals only, no accent, no icon, no tint, no gradient, no uppercase. This removes four existing violations in `renderStationRow` (workout-detail-modal.ts:25-86):
   - the uppercase tinted "Swapped" badge (:53)
   - the uppercase "Substitute" tag
   - the bordered 28 px icon button (:51-52)
   - the strike-through "replacing" line
5. The station row already exists. It is modified in place; no parallel card is added.

**Station row** (detail modal; the card gets the same text through `hyroxStationRowText`)
- Line 1, bold: the station name, always.
- Line 2, muted: the resolver's `rowText`, e.g. "Plate push, 4 × about 1:02 at RPE 5" or "2 × 250 m, damper 6".
- Line 3, muted, only for a default: "No sled in your setup." or "No SkiErg in your setup."
- Target column: a time-dosed substitute shows its set time. Today it shows a dash when a swap is active.
- Below the row: one text button, "Swap" or "Change swap" (12 px, `var(--c-muted)`, no border, no fill).
- Burpee broad jump rows and the assessment get no button.

**Swap view** (same overlay, `mode = 'swap'`; the overlay stays vertically centred; no stacked z-300 sheet)
- Title: "Swap Sled Push". Muted subtitle: "This session only. Same time and effort as the planned set."
- First row, "Use the station", with its muted advice line ("Any sled on turf or floor. Load it by posture."). For a default its line reads "Use a sled for this session." It is shown only when the station is not already what the session prescribes.
- Then `hyroxSubstituteOptions(station, { access, caps })` in rank order.
  - One row button each: the name in bold, then one muted line with this session's dose and the `needs` text, e.g. "4 × about 1:02 at RPE 5. Needs plates and a towel or turf."
  - The active option carries no badge; it is simply not listed as a choice.
- When the injury hides rows, one muted footnote: "Some swaps are hidden while lower-body capacity is 40%."
- Footer: Cancel (`m-btn-secondary`, full width). Picking a row is the action, with no Save step.

**On pick**
1. `next = withHyroxStationSub(live, station, choice, 'user', ctx)`.
2. Replace the session by id in `s.wks[wkIdx].triWorkouts`. If the id is not found there, search the current week, because the home card opens the modal without a week index (home-view.ts:3438; the modal defaults it at :102). This writes back by id; today's code mutates the object it was passed.
3. `saveState()`.
4. Re-render the detail mode with `next` and refresh the plan view. Never navigate to Home.

**Where the control shows:** current-week sessions not yet done (`wk.rated[id]` unset). Past weeks, done sessions and future weeks get none (future cards are untappable, plan-view.ts:320).

**Code**
- New `src/ui/hyrox/station-swap-view.ts`: `renderStationSwapView(workout, station, ctx)` and `wireStationSwapView(root, onPick, onCancel)`, so the guided runner can reuse it later.
- Delete `applyStationSwap` (:346-389), `openSubstitutionPicker` (:392-429), the old click handler (:269-289) and the `hyrox-substitutions` import (:11).
- Run `npm run lint:ui`. The baseline only shrinks.

---

## 6. Load, MTL, TSS and forecast credit

### 6.1 Aerobic TSS (planning; no code change)

- `hyroxSessionPlannedTss` (hyrox-session-shape.ts:139-155) prices the duration at `plannedTssPerMin(type, rpe)`, with the warm-up, strength block and finisher at their own rates.
- A time-dosed substitute keeps `durationSec` and the session RPE. A same-task substitute keeps the amount, so `estimatedDurationMin` is identical.
- So TSS is inherited by construction: session RPE × duration is mode-independent [33][34].
- No retained fraction and no consumer rescale, so the Load Currency Law holds. `load-currency-anchors.test.ts` is untouched.
- **Tracking:** the guided record, quick done (`strength-complete.ts`) or a synced activity wins, as for every session.

### 6.2 MTL (planning and tracking)

- `c.mtl = station MTL × mtlRatio`. The ratio is the formula `computeComponentMTL` (mtl.ts:37-64), `modality × impact × (1 + min(0.6, ext/bw × 0.5))`, for the substitute's row over the station's row, at the same minutes and RPE.
- It is a cached value derived per component from existing rows. It is not a hand-set table like the retired `mtlFactor`. A test pins every catalogue row to the formula quotient.
- It survives cuts, and the revert is exact.
- External load:
  - `'station'` uses the component's prescribed load (sleds × `SLED_EXTERNAL_LOAD_FRACTION`).
  - `'none'` uses no factor, following the codebase precedent for an implement of unknown mass ("an unloaded sled carries none here, its own mass unknown", hyrox-generators.ts:995-998).
- `finishHyroxSession` sums `c.mtl`, so the weekly MTL cap, `computeWeekMTL`, `computeWeekActualMTL`, the card and the chips all read the substitute's MTL with no changes.
- A user swap made after the build can push a week slightly over the MTL cap. The header chip shows it; there is no re-cap (section 11).
- Direction checks, each derived at runtime:
  - SkiErg to RowErg, air bike or BikeErg: 1.0.
  - SkiErg to a run at RPE 5 or 7: 0.8 / 0.35 = 2.29. MTL rises, as research §6 item 6 says it should.
  - M-Open sled push (152 kg, so 76 kg external) at body weight 75 kg to a plate push: 1 / 1.507 = 0.664.
  - Thrusters against a 6 kg ball at 75 kg: 1 / 1.04 = 0.96.
  - Trap bar, barbell, dumbbell or vest at race load: 1.0.

### 6.3 Forecast credit (prediction; founder rule, optimistic end of defensible)

- `race-prediction.hyrox.ts:1116-1127`: the `programmed` set becomes `HYROX_STATION_ORDER.filter(st => hyroxStationTrainable(st, access))`. That is all eight today. The `availableStations` import goes.
- A no-sled athlete's Sled Push and Sled Pull now bank horizon gain (`applyHyroxStationHorizon`, training-horizon.hyrox.ts:165). The weakest-link ranking and the Forecast hero move with them.
- `stationInjuryBuildWeeks` (hyrox-injury.ts:104-118) keeps debiting by the **station's** own region. A substitute never moves the injury debit.
- The horizon reads planned sessions per week, not a per-station dose. So a per-session swap cannot change the projection, and no re-forecast is needed.
- This supersedes SCIENCE_LOG §DI "no gain without equipment" (lane-h2b SCIENCE_LOG.md:8344, rule line :8363) and inverts `race-projection.hyrox.test.ts:330-345`.
- Known limitation, to log: cross-training transfer "never exceeded" sport-specific training [35], and research §5.3 recommended same-task-only credit.

### 6.4 Mirror rule

- Running and triathlon have no station equipment, so there is nothing to mirror.
- The gym exercise swap stays a standing preference, while the HYROX swap is per session (founder 2026-10-22). They are intentionally different; do not merge them.
- This is consistent with §BB (an injury substitute holds duration): this swap holds duration and effort.

### 6.5 Signals not changed (logged limitations)

- Signal A keeps the session's strength `runSpec`, so a run stand-in is not credited as running. That is conservative for run fitness.
- Signal C (impact) does not add the footstrike of a run stand-in.

---

## 7. Guided runner and benchmarks

1. **Labels.**
   - `describeHyroxComponent` (src/guided/strength-model.ts:190) calls `resolveHyroxComponent(workout, c)`. `parseHyroxSession` (:227) already has the workout.
   - The name stays the station name, so rings and progress stay grouped per station (founder: shown as that station).
   - The amount line becomes "Plate push, about 1:02 at RPE 5" for time, or "Trap-bar carry, 50 m, 2 × 24 kg" for amount. The cue comes from the catalogue.
   - Voice: "Next: Sled Push, as a plate push."
2. **Structure is unchanged.** A swap never changes sets, rests or durations, so the controller's indices, rest timers and auto-advance stand.
3. **Runs.** A run stand-in keeps its station `type`, so `getActiveRunComponent` (guided-strength-overlay.ts:149) never starts the GPS bridge. That is right: the run is dosed by time, and the per-set clock is the target.
4. **Finish summary** (`buildHyroxFinishSummary` :919): a substituted row reads "Done as a plate push. No station time recorded." in `var(--c-faint)`, with no percentile and no "new best".
5. **Benchmarks** (`hyrox-session-benchmarks.ts`).
   - `comparable` (:265) becomes `racePace && !partial && !reducedLoad && resolved.teachesBenchmark`.
   - A substitute, same-task included, never writes `stationBenchmarkHistory` and never calls `getStationPercentile` (:274). Surface friction alone differs up to about 3× [22].
   - `buildHyroxSessionRecap` (:193) adds `subId?` to each station entry (`GarminActual.hyroxSession.stations[i]`, state.ts:568).
   - `activity-detail.ts` labels the entry "Sled Push, as a plate push".
6. **ISSUE-404.** No new reads of the results tables. Gating only removes percentile calls. Substitute targets reuse the existing `durationSec`, with no new `hyroxStationSeedsAtTarget` call site.
7. **`hyroxTestableStations`** delegates to `hyroxRealKitStations`, so the generator and calibration share one equipment rule.

---

## 8. Files, commits and tests in build order

Prerequisite: fix/hyrox-h2b merged. Re-anchor all lines. Dump /tmp patches for the shared files.

**Commit 1: catalogue, resolver, capacity helper (pure; no behaviour change)**
- New: `src/constants/hyrox-station-substitutes.ts`, `src/workouts/hyrox-substitution.ts`.
- Edit: `src/types/triathlon.ts` (`sub`); `src/calculations/hyrox-injury.ts` (`hyroxModeCapacity`; the gate's `ownCap` calls it).
- Tests, `hyrox-substitution.test.ts`:
  - Catalogue integrity: valid station and row, `amount` and `'station'` only with `sameTask`, at least one source each, unique ids, no numeric fields. Nothing excluded in section 3 is present.
  - Grep anchors: no `mtlFactor` anywhere in `src/`; no results-table import in either new file.
  - Kit parity: `hyroxRealKitStations` equals the old `hyroxTestableStations` for all 12 sled × SkiErg × RowErg combinations.
  - Defaults: no SkiErg plus a RowErg gives RowErg; neither erg gives the run; no sled gives the sled defaults; `'sometimes'` and `'always'` give null; the four other stations give null.
  - MTL ratio: every row equals the formula quotient. Pins: SkiErg to run at RPE 7 is 2.2857; M-Open sled push to plate push at 75 kg is 1/1.5067; a run row at RPE 4 uses `run_easy`.
  - Capacity: the options filter over a capacity grid (0 to 100 in tens) never offers a row below the station's capacity.
  - `hyroxStationTrainable` is true for all 8 stations under every access combination.

**Commit 2: generator (version 20)**
- Edit: `src/workouts/hyrox-generators.ts` (sections 4.1 to 4.8), `src/workouts/plan_engine.hyrox.ts` (version only).
- Tests, `hyrox-generators.substitutes.test.ts`:
  - No drop: across 16-week beginner and intermediate plans, for every access combination, the union of stations is all 8 (assessment excluded), and no-kit components carry `by: 'default'`.
  - Full-kit plan identical to v19 output apart from the version.
  - TSS invariance: every row × technique, race pace, brick, secondary brick, full and half sim, and doubles leaves `estimatedDurationMin`, `hyroxSessionWorkSec` and `hyroxSessionPlannedTss` unchanged.
  - Revert exactness to 1e-9, with no snapshot field.
  - `sub` survives `withHyroxRounds`, `withHyroxPartialSets` and `withoutHyroxStation` (another station). `withHyroxStationLoads` recomputes the ratio.
  - Bricks for a no-erg athlete never hold a run-substituted erg; the taper mini-brick is unchanged.
  - A no-erg race week is still an easy run.
  - The assessment holds only real-kit stations and names the rest.
- Inverts `hyrox-generators.test.ts:164-168`; `:214-221` stays valid.

**Commit 3: plan engine (gate, load memory, carry)**
- Edit: `plan_engine.hyrox.ts` (sections 4.9 to 4.11), `src/state/hyrox-plan-regen.ts`, `src/ui/events.ts`.
- Tests:
  - Run-only injury, no ergs: the SkiErg's run default moves to the air bike at full share, with a note. At run 0 and full-region 0 the session follows the existing `off` rule.
  - A re-pick never raises component MTL.
  - Unsubstituted sessions gate identically to v19 (the existing `plan_engine.hyrox.rules` suites stay green).
  - Load memory: an easy-rated plate-push session does not step the sled load; an unswapped one still does.
  - Carry: a current-week user swap survives the version regen, the injury rebuild and the rollover rebake, and is never copied into a deload or taper repeat or a sibling session. It is dropped (with a note) when an injury disallows it, and dropped silently when the station is gone. It is not carried by init, prev-time or format-fix.

**Commit 4: tracking (forecast, benchmarks, recap)**
- Edit: `src/calculations/race-prediction.hyrox.ts`, `hyrox-session-benchmarks.ts`, `hyrox-station-history.ts`, `src/types/state.ts` (recap `subId`).
- Tests:
  - No-sled athletes project sled `improvementPct > 0` (inverts `race-projection.hyrox.test.ts:330-345`). A lower-body injury still debits.
  - A substituted race-pace station gives `eligible` false, `percentile` null, writes nothing, and the recap carries `subId`.

**Commit 5: UI and guided runner (retire the old swap)**
- New: `src/ui/hyrox/station-swap-view.ts`.
- Edit: `src/ui/hyrox/workout-detail-modal.ts`, `src/guided/strength-model.ts`, `src/ui/guided-strength-overlay.ts`, `src/ui/activity-detail.ts`, `src/types/state.ts` (delete the legacy fields).
- Delete: `src/constants/hyrox-substitutions.ts`.
- Tests:
  - jsdom, `workout-detail-modal.swap.test.ts`: rows in rank order; "Use the station" first; RowErg hidden without a RowErg; injury footnote shown; a pick writes back by id (and via the current-week fallback); re-renders without navigating to Home; no uppercase in rendered styles.
  - Guided: a swapped session keeps its set count and rests, and its labels read as section 7 says.
  - The v19 to v20 regen with legacy `hyroxStationSubs` neither throws nor leaves those fields.
- Gates: `npm run lint:ui` (baseline shrinks), `npx tsc --noEmit`, `npx vitest run`.

**Commit 6: docs**
- `docs/SCIENCE_LOG.md`, new entry (next free letter at merge; §DR on main today):
  - the dosing tiers and the ratio formula
  - the row mapping (research §5.2) and the run-row RPE rule
  - the `'none'` precedent and its under-count
  - the forecast rule, the Tanaka limitation, and the injury debit staying on the station
  - the retired `mtlFactor` table and the misattributed Damas 2016 citation (research §6.7)
  - superseding §DI
- `docs/FEATURES.md`, `docs/ARCHITECTURE.md` (resolver module and data flow), `docs/CHANGELOG.md` (behaviour changes for limited-kit athletes).
- `docs/DEVICE_TESTS.md`: the swap view and guided labels on WKWebView and desktop Chromium.
- Do not mark any issue fixed until Tristan confirms on device.

---

## 9. Every number and its source

| Number | Use | Source |
|---|---|---|
| Modality and impact rows: ski_erg and row_erg 0.5 / 0.7; sled_push and sled_pull 1.2 / 1.0; farmer_carry 1.0 / 1.0; sandbag_lunges and wall_balls 1.1 / 1.0; run_easy 0.6, run_tempo 0.8 (impact 1.0) | Substitute MTL rows | `STATION_MTL_FACTORS`, `RUN_MTL_FACTORS`, hyrox-constants.ts:256-273 (existing) |
| 0.6 cap and 0.5 slope on external load ÷ body weight | Inside the ratio | `computeComponentMTL`, mtl.ts:56-60 (existing) |
| 0.5 sled external fraction | Station external load | `SLED_EXTERNAL_LOAD_FRACTION`, hyrox-benchmarks.ts:172 |
| RPE 4 | `run_easy` at or below, `run_tempo` above | `HYROX_EASY_RPE`, hyrox-constants.ts:669; brick precedent hyrox-generators.ts:1245 |
| Set time per substitute | Time dose | Each component's existing `durationSec` (`stationSeedSec` :222 × `HYROX_STATION_SET_FRACTION` 0.25, hyrox-station-dose.ts:43) |
| Race loads (e.g. M-Open sled push 152 kg, ball 6 kg) | Amount dose and worked examples | `HYROX_LOAD_TIER_KG`, hyrox-benchmarks.ts:150-160 |
| 2 stations | Circuit floor (unchanged) | `MIN_CIRCUIT_STATIONS`, hyrox-generators.ts:217 |
| 20 | Version counter | `HYROX_GENERATOR_VERSION` 19 to 20, plan_engine.hyrox.ts:480 |
| 1.0, 2.29, 0.664, 0.96 | Worked ratios | Derived at runtime from the rows above; not constants |
| Research per-coach ranges (40-80 kg plate push, 6-10 × 15-30 m hill sprints, 60-100 swings) | Not used | The founder time-and-effort rule replaces them |
| External load for unknown implement mass | `'none'` | Codebase precedent, hyrox-generators.ts:995-998. Decided by precedent; under-counts MTL (a plate push reads 66% of an M-Open race sled). Logged as a limitation. |

NEEDS DECISION: the default order (founder call 1) and MTL rows for the held-out substitutes (founder call 2). Nothing else in this design needs a new number.

---

## 10. Remaining founder calls

**1. Default stand-in for each station you have no kit for.**
- Options:
  - Sled Push: plate push on a towel or turf, a curved treadmill sled mode, or a hill run.
  - Sled Pull: cable rope pull, or a rope round a loaded plate.
  - SkiErg and RowErg: the other erg first, then a run, or the air bike before the run.
- **Recommendation:**
  - Sled Push: plate push (research rank a3, above hill sprints at a4; needs only plates).
  - Sled Pull: cable rope pull (rank a2, [C]).
  - SkiErg: RowErg if owned, else a run or brisk incline walk.
  - RowErg: SkiErg if owned, else a run.
- Basis: the plan already assumes commercial-gym implements for the carry, lunges and wall balls. An athlete with no rower is most likely training at home, where a run needs nothing [I].

**2. Home and no-equipment stand-ins that have no MTL row in the research.**
- The rows: KB swings, snatches, med-ball slams, burpees, DB floor push, goblet walks, wall drives, bear crawls, band rows, backpack backward walks, towel rows, inverted rows, air squats.
- Options:
  - (a) Leave them out of v1.
  - (b) Approve borrowed rows now. Proposed: slams and air squats with reach to `wall_balls`; burpees to `burpee_broad_jumps`; floor push, wall drives and bear crawls to `sled_push`; band, backpack and towel pulls to `sled_pull`. Swings and snatches have no fitting row.
- **Recommendation: (a).** v1 still gives home athletes the run and walk options, bodyweight or backpack lunges, loaded-bag carries and the hill run. Rows are added later as you approve them.

**3. Swaps on future weeks.**
- Options:
  - (a) Current week only. Future cards stay untappable, as today.
  - (b) Let a future-week card open for the swap alone, e.g. a hotel gym next week. The carry already keeps such swaps through rebuilds.
- **Recommendation: (a)** for v1. It keeps the change inside the surface people already use. (b) is a small follow-up once v1 is verified on device.

---

**Decisions (Tristan, 2026-10-22):**
1. Defaults: the research picks. Sled push: plate push. Sled pull: cable rope pull. SkiErg: RowErg if owned, else a run or brisk incline walk. RowErg: SkiErg if owned, else a run.
2. Include the home and no-equipment stand-ins with borrowed rows: slams and air squats with reach on `wall_balls`; burpees on `burpee_broad_jumps`; floor push, wall drives and bear crawls on `sled_push`; band, backpack and towel pulls on `sled_pull`. KB swings and snatches stay out (no fitting row). Log each borrowed row in SCIENCE_LOG as a mapping, not a measurement.
3. Allow swaps on future-week sessions: a future-week card opens for the swap alone (plan-view.ts future-week tap gate). The carry keeps such swaps through rebuilds; they stay session-only.

Build after lane `fix/hyrox-h2b` merges.

## 11. Later

- In-session swap from the guided runner ("the sled is taken"): a muted "Swap this station" button on the rest or pre-station screen. It opens `station-swap-view` above the runner, writes back, then relabels the remaining sets from a fresh `parseHyroxSession`. Indices stay valid because a swap never changes structure.
- Swap after the fact on a done session, to correct the MTL record (needs a rule for a benchmark already written).
- Founder call 2 option (b) rows, as approved.
- Re-run the weekly MTL cap after a user swap that raises MTL (run stand-ins at 2.29×).
- Signal C impact and Signal A running credit for run stand-ins.
- Activity matcher: a synced air-bike or cycling file standing in for a station slot.
- The research's setup checklist (preset plus air bike, curved treadmill, cable, wall ball, lunge load, carry implements) and "sometimes" sled cadence (research §4 and §7 item 4). Not built, by founder decision; revisit if defaults misfire for home athletes.
- An MTL external load from a real implement mass, if setup ever asks for it.
