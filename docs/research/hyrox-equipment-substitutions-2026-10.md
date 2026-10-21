# HYROX equipment substitutions: research for the rebuild (2026-10-20)

Scope: what to prescribe when an athlete lacks HYROX kit, how to dose it, what to ask at onboarding, and how to account for its load. Read-only research; no code changed.

**Evidence labels used throughout**

- **[E]** peer-reviewed evidence
- **[C]** coaching consensus (three or more independent coach or programme sources agree)
- **[S]** a single coach, programme or vendor source
- **[I]** my inference, not stated by any source

**What I could not find.** No published substitution guidance from Hunter McIntyre, Roxfit, Hybrid Performance Method or Coopah turned up in search; McIntyre's own reported training uses real sleds. No official hyrox.com page on substitutions was found. The HYROX365 "minimum requirements to become a HYROX Training Club" FAQ answer is not publicly retrievable (the page says "Any kind of gym is suitable"). The strongest semi-official source is **Repz**, named HYROX Official Online Training Partner on 13 August 2026, whose app plans around "available gym equipment" [8]. No peer-reviewed study validates any HYROX station substitute against the real station.

---

## 1. Summary of recommendations

- **Never silently drop a station.** Coaches universally substitute; none recommend omitting sled work. Today `availableStations` (`src/workouts/hyrox-generators.ts:107`) removes both sleds for no-sled athletes, so they get zero sled-pattern stimulus all plan. [C]
- **Dose substitutes by time and effort, not by converted metres, kg or reps.** No published or validated kg-for-kg, rep-for-metre or calorie conversion exists for any station [5][7]. Cross-modality physiology says equal displayed power or distance is not equal load; equal heart rate and duration is [23][24][25]. The rule coaches publish is "time the prescribed piece, do something else for that time at the same effort" [7][32][10]. [E] + [C]
- **Use three dosing tiers.**
  1. *Same task, different place*: a real sled on gym turf, carries at race load, lunges at race load, wall balls to a marked target. Match distance or reps. Set the sled load by posture, not by race kg.
  2. *Different implement, same energy system*: another erg, an air bike, a curved treadmill sled mode. Match the athlete's planned component time (`HyroxComponent.durationSec`, already athlete-specific) and the station's target RPE.
  3. *Strength support*: leg press, rows, pulldowns. Prescribe as strength sets that never stand in for conditioning time. [I], built on [C] sources.
- **Rank substitutes by task fidelity.** Per-station tables are in section 2. The highest-fidelity substitutes exist for the farmers carry, lunges, wall balls and burpee broad jumps. The sleds and SkiErg are the hardest to replicate [C].
- **Treadmill sled push.** Prescribe it only on curved manual treadmills with a manufacturer resistance or sled mode (Woodway Curve FTG, Technogym SkillMill, REP Strive) [17][18][19]. Many coaches recommend pushing a switched-off motorised treadmill [2][16][10][11]. HYROX's official training partner warns against it [6]. Founder call (section 7).
- **Replace the three toggles with a gym-type preset plus a short editable checklist** of the items that change prescription: sled with a "sometimes" option, SkiErg, RowErg, air bike or BikeErg, a curved treadmill with sled mode, a wall ball with a throwable wall, a lunge load, carry implements at race weight, and a cable machine. See section 4.
- **Load accounting: no "stimulus retained" fraction.**
  - Aerobic TSS inherits the station's planned value only when the substitute is time- and RPE-matched; actuals win when logged.
  - MTL is recomputed with the existing MTL formula from the substitute's own movement profile, reusing existing factor rows and its real implement mass.
  - Forecast credit for a station uses a binary same-task rule, never a percentage. See section 5.
- **Retire `src/constants/hyrox-substitutions.ts` as written.** Its rep counts and `mtlFactor` values are unsourced, it cites a paper that does not support it, and several factors point the wrong way. See section 6.

---

## 2. Per-station substitutes by context

Contexts: **(a)** a commercial gym with dumbbells, kettlebells, barbells, cables, treadmills (some curved or non-motorised), an air bike and a leg press, but no sled track, SkiErg, wall-ball target or sandbag. **(b)** Minimal home kit: one pair of dumbbells or kettlebells. **(c)** Nothing.

"Time-matched" means work for the athlete's planned time for that component, from their benchmark or band seed (`stationSeedSec`, `hyrox-generators.ts:166`; per round in `HyroxComponent.durationSec`), at the station's target RPE. Rank 1 is the best stimulus match within that context.

Race standards below are Open loads, already encoded in `hyroxStationRaceStandard`:

- Sled push: 152 kg men, 102 kg women, including the sled.
- Sled pull: 103 kg men, 78 kg women.
- Farmers carry: 2 × 24 kg men, 2 × 16 kg women.
- Sandbag lunges: 20 kg men, 10 kg women.
- Wall balls: 6 kg men, 4 kg women, to targets at 3 m and 2.7 m.

[2][3][9][10]

### SkiErg 1000 m

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | RowErg | Time-matched at the same RPE. Metres are not interchangeable: "There is no universal conversion." | [C] same Concept2 flywheel and monitor, both pulling ergs; standing hinge vs seated leg drive differ | [7][28] |
| a | 2 | Air bike (arms and legs) | Time-matched at the same RPE, with the original recoveries | [S] | [7] |
| a | 3 | BikeErg | Time-matched. Under Concept2's challenge convention a BikeErg metre counts as half a RowErg or SkiErg metre. That is an accounting rule, not a physiological equivalence | [S] + [E] caveat | [28][29][23] |
| a | support | Straight-arm cable or rope pulldown | Strength sets only; "doesn't reproduce continuous skiing" | [C] | [7][11][12] |
| b | 1 | Alternating DB or KB snatches | Time-matched (one coach gives 40-60 reps in 3-5 min at 12-20 kg) | [S] | [10][15] |
| b | 2 | KB swings | Time-matched | [S] (listed by [10] as a rower substitute; hip-hinge pull) | [10] |
| b | alt | Med-ball slams or band pulldowns, if the athlete owns a ball or band | Time-matched, 3-5 min continuous | [C] | [10][12][7] |
| c | 1 | Run or brisk incline walk at station effort | Time-matched. Adds footstrike impact the erg lacks; "neither recreates resisted pulling" | [S] | [7] |
| c | 2 | Burpees or similar heart-rate raisers | Time-matched | [S] (general cardio-swap advice, not SkiErg-specific) | [32] |

Notes: the SkiErg is widely called the hardest station to learn without the machine [39][46]. Concept2 counts RowErg and SkiErg metres 1:1 when combining in its challenges [28]. A SkiErg test gives lower VO2peak than a treadmill test in average-fit women [27], so treadmill or run fitness overstates SkiErg capacity. [E]

### Sled push 50 m (4 × 12.5 m)

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | Any gym sled or prowler on turf or floor (no track needed, shuttles) | Distance-matched 50 m in 12.5 m lengths. Load by posture, not race kg: "If you can push it upright easily, it is too light." Surface friction varies widely (μ 0.21-0.58 across four surfaces); coaches report gym turf feels lighter than race carpet | [E] friction, [C] load rule | [9][22][44] |
| a | 2 | Curved manual treadmill with a manufacturer resistance or sled mode | Time-matched in four efforts (one per lane length); resistance set so the athlete holds a sled-push posture | [S] vendors + [I] dosing; SKILLRUN sled mode raises quad and calf EMG and alters gait with load, never validated against an overground sled | [17][18][19][20] |
| a | 3 | Plate push on a towel or turf | Distance or time-matched; one coach gives 40-80 kg, 15-25 m sets | [C] | [2][16][10] |
| a | 4 | Hill sprints or resisted incline sprints | 6-10 × 15-30 m as power work, plus time-matched conditioning | [C] | [9][2][16] |
| a | support | Leg press, back or front squat, split squats | Strength sets (one coach gives 4-5 × 3-6); not a conditioning substitute | [C] + [E]: half squat and sled push give similar quad, hamstring and oblique EMG; sled is higher for calf, squat higher for erector spinae; sled is concentric-dominant | [9][21][46] |
| a | contested | Switched-off motorised treadmill push | Recommended by several coaches; HYROX's official training partner says not to push an ordinary switched-off treadmill, and owner manuals restrict use to the intended purpose | Conflict | [2][16][10][11] vs [6] |
| b | 1 | DB or KB floor push, or heavy goblet walks | Time-matched (one coach gives goblet walks at 24-40 kg, 50 m) | [S] | [2][10][15] |
| b | support | Walking lunges, step-ups, split squats | Strength support only | [C] | [2][9] |
| c | 1 | Hill sprints | Short repeats plus time-matched work; "one of the closest no-equipment substitutes" for drive | [S] | [9][2] |
| c | 2 | Wall drives, low-stance marches, bear crawls | 4-6 × 20-40 s (one coach), or bear crawls 4 × 20 m (another) | [C] | [9][13] |
| c | not in app | Car or partner push | Coaches list it with safety warnings; load cannot be standardised | [S] | [2][16] |

Mountain climbers add "little leg resistance" [2]. They are not a sled substitute.

### Sled pull 50 m (rope, 4 × 12.5 m)

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | Any gym sled with a rope, on turf or floor | Distance-matched, load by feel (friction caveat as above) | [C] | [3][22] |
| a | 2 | Cable-stack rope pull: hand-over-hand or seated rope pulls, plus backward walks under cable tension | Time-matched (one coach gives 40-60 kg, 30-50 reps; another gives 3 × 20 backward steps) | [C] | [10][11][14] |
| a | 3 | Rope looped around a loaded plate or improvised sled, pulled hand over hand | Distance or time-matched | [S] | [11] |
| a | support | Bent-over and single-arm rows, deadlifts, rope-grip pull-ups | Strength sets. "cannot fully reproduce the technique, rope management and variable resistance" | [C] | [3][14][46] |
| b | 1 | Band rows and backward band walks; DB bent-over or gorilla rows | Time-matched for band work; strength sets for DB rows | [C] | [13][11][14] |
| c | 1 | Backward walks with a loaded backpack; towel rows on a door handle | Time-matched | [S] | [13][12] |
| c | 2 | Inverted rows under a sturdy table | Time-matched | [I] (in current code; coaches list inverted rows only as a rowing substitute [10]) | [10] |

### Burpee broad jumps 80 m

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| all | 1 | The station itself (needs only floor space) | Distance or rep-matched; shuttle out and back if space is short | [C]: "No substitute is recommended; train the movement directly" | [10][11][12] |
| all | 2 | Burpee then a separate standing broad jump, alternating | 40 + 40 for 80 total (one source) | [S] | [12] |
| all | 3 | Burpees without the jump | Rep-matched. Loses the horizontal jump and its landing load | [S] | [13] |

### RowErg 1000 m

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | SkiErg (if present) | Time-matched at the same RPE | [C] (mirror of the SkiErg row) | [7][28] |
| a | 2 | Air bike | Time-matched at the same RPE | [S] | [7] |
| a | 3 | BikeErg | Time-matched; Concept2 half-metre convention as above | [S] + [E] caveat: at matched power the RowErg produces higher VO2, HR and ventilation than the BikeErg | [23][28] |
| b | 1 | KB swings | Time-matched (one coach gives 16-24 kg, 60-100 swings in 3-5 min) | [S] | [10] |
| b | 2 | DB deadlift-to-row | Time-matched | [S] | [10] |
| c | 1 | Run at station effort | Time-matched; adds impact | [S] | [7] |
| c | 2 | Inverted bodyweight rows | Time-matched (one coach gives 60-100 reps in 3-5 min) | [S] | [10] |

Commercial gyms almost always have a rower, so this matters most for home athletes [I].

### Farmers carry 200 m

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | DB or KB carry at race weight | Distance-matched 200 m (shuttles) | [C] same task | [10][11] |
| a | 2 | Trap-bar carry at the matching total load | Distance-matched | [C] | [10] |
| b | 1 | The pair the athlete owns, lighter than race weight | Time-matched or longer, with grip-limited holds; no published load-to-distance conversion exists | [C] for the swap, [I] for dosing | [13][12] |
| c | 1 | Loaded bags, backpacks or water containers | Time-matched; load is hard to standardise | [C] | [10][12][13] |

### Sandbag lunges 100 m

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | Barbell back-rack walking lunges at race load (a standard 20 kg bar equals the men's Open sandbag) | Distance-matched 100 m | [C] + [I] for the bar note | [10][11] |
| a | 2 | Front-rack DB walking lunges | Distance-matched (one coach gives 10-15 kg per hand for men, 5-10 kg for women) | [C] | [10][11] |
| a | 3 | Weighted-vest walking lunges | Distance-matched | [S] | [10] |
| b | 1 | DB or KB front-rack or goblet walking lunges at the load the athlete owns | Distance-matched | [C] | [10][11] |
| c | 1 | Bodyweight or backpack walking lunges | Distance-matched; one source gives 200 steps with a 15-25 kg pack | [C] | [12][13] |

Do not trust Hybrid Pro Coach for this station's distance: it states 200 m [10], but the race is 100 m.

### Wall balls 100 reps

| Ctx | Rank | Substitute | Dosing rule | Basis | Sources |
|---|---|---|---|---|---|
| a | 1 | Med ball thrown to a marked height on any wall where throwing is allowed | Rep-matched at race ball weight | [C] | [10][11] |
| a | 2 | DB or barbell thrusters | Rep-matched at a load that keeps race rhythm (one coach gives 2 × 8-12 kg DB or a 20-30 kg bar). No published conversion exists between a thrown 6 kg ball and a thruster load. Loses the throw, catch and aim | [C] | [42][10][15] |
| b | 1 | DB or KB thrusters, or goblet squat to press | Rep-matched, 100 reps | [C] | [12][10][15] |
| c | 1 | Air squats, ideally with an overhead reach | Time-matched (the current code's "200 air squats" doubling has no source) | [S] for air squats, [I] for dosing | [15] |

Wall balls produced the race's peak HR, lactate and RPE in the only HYROX physiology study, possibly because they come last [1].

---

## 3. Dosing conventions

**Matching variable: time plus effort.** [E] + [C]

- Equal displayed power is not equal physiological load across machines. At matched power the RowErg drives higher VO2, HR and ventilation than the BikeErg [23]. Rowers' WattBike power differs enough from rowing power that the authors recommend prescribing cross-modality sessions by heart rate [24]. Rowing ergometers of different designs show "similar physiological profiles" at equal heart rate but differ at matched power [25]. An air bike elicits a higher VO2max and HRmax than a leg-only cycle ergometer [26].
- Coaches publish the same rule in plain terms:
  - Invictus: time the prescribed piece and do something else for that duration [32].
  - Repz: match interval duration and perceived effort, and keep the original recovery [7].
  - Hybrid Pro Coach: match movement pattern first, then the energy-system duration (3-8 min per station) [10].
- Session RPE × duration is a validated, mode-independent internal-load measure [33][34]. That is why a time- and RPE-matched substitute carries the same internal load by construction.

**Published conversions that exist**

| Convention | Value | Status |
|---|---|---|
| Concept2 challenges | BikeErg metres count as half; RowErg and SkiErg metres combine 1:1 | Official accounting rule [28]. A forum post explains it as equal flywheel energy, and the same poster says the RowErg's metabolic cost is "considerably higher" at equal power [29] |
| Invictus cardio chart | 400 m run = 500 m row = 1000 m BikeErg = 30/25 cal Assault Runner | Coach chart for a "general to slightly competitive population"; method not disclosed; the full table is a download [31] |
| Concept2 calories | The monitor's estimate assumes a 79.5 kg person; corrected kcal/h = PM kcal/h − 300 + 1.714 × weight | Machine-specific estimate [30]. Calories are not interchangeable across brands [7] |

**Conversions that do not exist (do not invent them)**

- SkiErg ↔ RowErg metres: "There is no universal conversion" [7].
- SkiErg metres → air-bike calories: none found from any source.
- Sled kg → plate, treadmill or leg-press kg, and sled metres → reps: "no validated kilogram-for-kilogram or repetition-for-metre conversion" [5]; "no validated percentage of HYROX transfer" [6].
- Even sled to sled, kg does not transfer. Friction coefficients differ up to almost threefold across surfaces [22]. One coach says train 10-15% heavier than race weight; one athlete adds 40 kg at their gym [44]. Both are anecdotes.

**Real-kit exposure.** Coaches recommend some sessions on the actual equipment before race day: "two or three pushes before a race, or fortnightly if available" [9], and a gym with sleds during the peak block 8-12 weeks out [39]. [C] This is the case for a "sometimes" sled option that schedules real-sled sessions late in the plan.

**Factual correction.** FitnessVolt says "The sled push and pull are 20-25% of the race time" [39]. Brandt et al. measured median 128 s (push) and 155 s (pull) inside an 86.5 min median finish [1]. By my arithmetic on those medians, that is about 5.5% of finish time and about 14% of station time. [E] + [I]

---

## 4. Onboarding equipment checklist recommendation

**What others ask**

- Repz builds the plan around "available gym equipment" and suggests alternatives when equipment is limited [8].
- RoxHype's assessment covers "equipment access and gym setup" [45].
- Relentless "adapts to each athlete's ability, equipment, and schedule" [40].

**What HYROX-style gyms stock.** These are third-party lists; the official minimum is not public:

- OriGym's list, attributed to HYROX: treadmills or 1 km of run space, a SkiErg, a sled with bumper plates, a track and a rope, a rower (Concept2 recommended), kettlebells (2 × 16, 2 × 24, 2 × 32 kg), sandbags (10, 20, 20, 30 kg) and wall balls (4, 6, 6, 9 kg) [36].
- REP Fitness's minimal start: one conditioning machine, a sandbag, kettlebells and a wall ball, adding a sled and target later [38].
- RH Training Club's minimal list: dumbbells or kettlebells; "Sled, Medicine Ball, Kettlebell"; cardio access; a band; a pull-up bar or alternative; a jump rope [48].

**Recommendation** [I]

Use a preset first ("Where do you train?": HYROX gym or training club / commercial gym / home with dumbbells or kettlebells / no equipment). Then show an editable list containing only the items that change what the generator prescribes:

| Item | Options | Why it changes the plan |
|---|---|---|
| Sled you can push and pull (with a rope) | Regularly / Sometimes / No | No: substitutes. Sometimes: real-sled sessions in the build and race-specific weeks, substitutes otherwise ([9][39]). The `'sometimes'` value already exists in the type |
| SkiErg | Yes / No | Erg substitution |
| RowErg | Yes / No | Erg substitution |
| Air bike or BikeErg | Yes / No | Best erg substitute when SkiErg or RowErg is missing |
| Curved treadmill with a resistance or sled mode | Yes / No (ask only if sled = No) | Highest-fidelity sled-push substitute in a commercial gym |
| Cable machine | Yes / No (ask only if sled = No) | Best sled-pull substitute |
| Wall ball and a wall you can throw at | Yes / No | Rep-matched wall balls vs thrusters |
| Something to lunge with at race load (sandbag, barbell or dumbbells) | Yes / No | Loaded vs bodyweight lunges |
| Carry implements at race weight (shows the tier's kg) | Yes / Lighter / None | Distance-matched vs time-matched carries |

Asking for a sandbag specifically is unnecessary, because a barbell or dumbbells give the same lunge stimulus [10][11]. Asking for a wall-ball "target" is also unnecessary: a marked height on a permitted wall works [10][11]. The founder sets each preset's defaults.

---

## 5. Load-accounting recommendation

Per CLAUDE.md, each part is labelled as planning (what is prescribed) or tracking (what was done).

**Recommendation: no "stimulus retained" fraction. Inherit where the dose is matched; recompute where the movement differs; never rescale.**

1. **Aerobic and anaerobic TSS (planning and tracking).** A substitute dosed to the component's planned time at the station's target RPE inherits the component's planned TSS. TSS here is time × intensity, so the match holds by construction, and session RPE × duration is mode-independent [33][34]. When the athlete logs the session (time, RPE, HR), the actual wins, as with every other session. A strength-support movement that is not time-matched is costed as strength, not as the station. This keeps the Load Currency Law intact: a retained fraction would be a consumer-side rescale of a load the athlete actually produced.
2. **MTL (planning and tracking).** Recompute with the existing formula (`src/calculations/mtl.ts:9`: duration × sRPE × modality × impact × (1 + externalLoadFactor)). Use the substitute's own movement profile, picked from existing rows in `STATION_MTL_FACTORS` / `RUN_MTL_FACTORS` (`src/constants/hyrox-constants.ts:249`), and the real implement mass. No new constants are needed:
   - air bike, BikeErg, other ergs → `row_erg`
   - plate push, treadmill sled mode → `sled_push`
   - cable rope pull → `sled_pull`
   - DB, KB or trap-bar carry → `farmer_carry`
   - any loaded lunge → `sandbag_lunges`
   - thrusters, med-ball throws → `wall_balls`
   - run substitutes → the matching run intensity

   This gets the direction right (section 6, items 5 and 6). Leg press, rows and pulldowns fit no existing row. Cost them through the existing gym-session path, or ask the founder; do not invent a factor.
3. **Station-specific forecast credit (tracking and prediction).** This is a separate question from load. A substitute produces no station time, so it never feeds station benchmarks. Use a **binary same-task rule** for whether a session counts toward that station's training horizon:
   - These count as the station: a real sled on any surface, a race-load carry with any implement, a race-load lunge with any implement, and wall balls to a marked target.
   - Everything else counts fully toward aerobic fitness and MTL but not toward the station's horizon.

   Specificity supports withholding credit: cross-training transfer "never exceeded" sport-specific training [35], and no transfer percentage exists [6]. A fraction would be invented. Whether to adopt the binary rule or give no credit at all is a founder call.

**Why not a fraction.** No validated transfer numbers exist anywhere [5][6]. The fractions already in the repo are unsourced:

- the 0.5-0.9 `mtlFactor` values in `hyrox-substitutions.ts`
- the 0.65-0.95 "specificity penalties" in `docs/research/hyrox.md` §3.4 (line 140)

Using either would break CLAUDE.md's "No Made-Up Numbers" rule.

---

## 6. Conflicts with the current code

1. **Silent drop of the sleds.** `availableStations` (`src/workouts/hyrox-generators.ts:107-114`) removes `sled_push` and `sled_pull` when `sled === 'never'`, and `pickStations` (`:122`) rotates only through what remains. The forecast also gives those stations zero horizon weeks (SCIENCE_LOG ~line 8419). Every source substitutes; none omits [2][3][9][10].
2. **Four stations assumed always available.** Burpee broad jumps, farmers carry, sandbag lunges and wall balls are hard-coded as available (`:113`). That is reasonable for burpee broad jumps. The other three are prescribed at race implements the athlete may not own, with no substitute.
3. **`'sometimes'` is unreachable and unused.** The type allows `'always' | 'sometimes' | 'never'` (`src/types/triathlon.ts:94`). The setup UI offers only "Have access" or "No access" (`src/ui/wizard/steps/hyrox-setup.ts:412-413`), and the generator treats `'sometimes'` as `'always'`.
4. **Fixed doses ignore the prescription.** Substitutes in `src/constants/hyrox-substitutions.ts` carry fixed counts ("500m moderate run instead of 1000m ski", "3 min continuous jumping jacks", "50 reps" squat thrusts, "150 alternating walking lunges", "200 air squats"). They ignore the component's prescribed distance or reps and its athlete-specific `durationSec`. None of these counts appears in any source found.
5. **Swaps change MTL only.** `applyStationSwap` (`src/ui/hyrox/workout-detail-modal.ts:338-379`) rescales `c.mtl` and `musculoTendonLoad` by `mtlFactor` but leaves aerobic and anaerobic load untouched. A 500 m run (about half the duration of a 1000 m ski) therefore keeps the ski's full TSS.
6. **Several `mtlFactor` values point the wrong way.**
   - Running substitutes for ergs get 0.7 × the erg's MTL, but under the codebase's own factors running carries more MTL per minute than an erg (`run_easy` 0.6 × 1.0 vs `ski_erg` 0.5 × 0.7, `hyrox-constants.ts:249-265`).
   - Squat thrusts and squat jumps get MTL below the sled push, which they replace. Those substitutes add jumping and landing, while the sled push is concentric-dominant [21].
7. **Unsupported citation.** The file header cites "Damas et al. 2016 on equivalent eccentric stimulus across modalities". The 2016 Damas *Eur J Appl Physiol* paper (116(1):49-56; SCIENCE_LOG gives "116(5)") is about edema-induced muscle swelling early in resistance training. It is not a cross-modality equivalence study. The header also says "Each option preserves approximate MTL", which the 0.5-0.9 factors contradict. No SCIENCE_LOG entry exists for the substitution factors.
8. **Earlier spec not built.** `docs/research/hyrox.md` §13.2 (line ~903-907) specified sled always / sometimes / never, erg checkboxes and "Wall ball target? yes / no", with substitution driving hill or treadmill pushes. The wall-ball question and the substitution routing were never built.
9. **Picker framing.** The picker is titled "No equipment substitute" (`workout-detail-modal.ts:392`) and offers only home or bodyweight options. A commercial-gym athlete with a cable stack, air bike and barbell gets the same list as someone with nothing.

---

## 7. Open questions for the founder (product calls only)

1. **Treadmill sled push.** Prescribe only on curved manual treadmills with a manufacturer resistance mode? Or also the switched-off motorised treadmill push that many coaches recommend, which HYROX's official training partner warns against [6]?
2. **Forecast credit for substituted stations.** Use the binary same-task rule in section 5.3, or give substitutes no station-horizon credit at all?
3. **Onboarding length and presets.** Use the preset plus up to 9 items (section 4), and choose what "commercial gym" defaults to.
4. **"Sometimes" sled cadence.** How many real-sled sessions to schedule, and in which phases? Coach guidance is thin: one source says two or three before a race or fortnightly [9]; another says in the peak 8-12 weeks [39].

---

## 8. Sources

Peer-reviewed

- [1] Brandt T, Ebel C, Lebahn C, Schmidt A (2025). Acute physiological responses and performance determinants in Hyrox: a new running-focused high intensity functional fitness trend. *Front Physiol* 16:1519240. https://doi.org/10.3389/fphys.2025.1519240 (abstract: https://public-pages-files-2025.frontiersin.org/journals/physiology/articles/10.3389/fphys.2025.1519240/text)
- [20] Martínez-Serrano A et al. (2021). EMG, stiffness and kinematics of resisted sprint training in the SKILLRUN treadmill. *Sensors* 21(22):7482. https://pmc.ncbi.nlm.nih.gov/articles/PMC8622140/
- [21] Maddigan ME, Button DC, Behm DG (2014). Lower-limb and trunk muscle activation with back squats and weighted sled apparatus. *J Strength Cond Res* 28(12):3346-3353. doi:10.1519/JSC.0000000000000697 (summary used: https://sci-sport.com/activation-musculaire-squat-vs-sled/)
- [22] Linthorne NP, Cooper JE (2013). Effect of the coefficient of friction of a running surface on sprint time in a sled-towing exercise. *Sports Biomech* 12(2):175-185. https://bura.brunel.ac.uk/handle/2438/8685
- [23] Turner KJ, Rice AJ (2021). Physiological responses on the Concept II BikeErg and Concept II RowErg in well-trained male rowers. *Int J Sports Sci Coach* 16(3):741-748. https://doi.org/10.1177/1747954120968183
- [24] Lindenthaler JR et al. (2018). Differences in physiological responses during rowing and cycle ergometry in elite male rowers. *Front Physiol* 9. https://doi.org/10.3389/fphys.2018.01010
- [25] Mahony N, Donne B, O'Brien M (1999). A comparison of physiological responses to rowing on friction-loaded and air-braked ergometers. *J Sports Sci* 17(2):143-149. https://lida.sport-iat.de/twm/Record/4002282?lng=en
- [26] Canário-Lemos R et al. (2022). Validity and reliability of maximum oxygen uptake on an Air Bike arm- and leg-ergometer. *Motricidade* 18(3):404-409. https://doi.org/10.6063/motricidade.26611
- [27] Nelson H et al. (2021). Comparison of peak aerobic capacity between the treadmill and a skiing ergometer. *J Exerc Nutr* 4(3). doi:10.53520/jen2021.103101. https://www.journalofexerciseandnutrition.com/index.php/JEN/article/view/101
- [33] Foster C et al. (2001). A new approach to monitoring exercise training. *J Strength Cond Res* 15(1):109-115.
- [34] Haddad M et al. (2017). Session-RPE method for training load monitoring. *Front Neurosci* 11:612. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5673663/
- [35] Tanaka H (1994). Effects of cross-training. *Sports Med* 18(5):330-339. https://pubmed.ncbi.nlm.nih.gov/7871294/
- Damas F et al. (2016). Early resistance training-induced increases in muscle cross-sectional area are concomitant with edema-induced muscle swelling. *Eur J Appl Physiol* 116(1):49-56. (Cited only to show it does not support the current header.)

Concept2 and machine manufacturers

- [17] REP Fitness, treadmill sled pushes (Strive curved treadmill, 8 levels; Jake Dickson, NASM-CPT). https://repfitness.com/blogs/training/sled-push-on-tread
- [18] Woodway Curve FTG (20 resistance levels; "mimics sled pushes"). https://www.woodway.com/products/curve-ftg/
- [19] Technogym SkillMill launch (MULTIDRIVE resistance "from zero to max"). https://www.athleticbusiness.com/industry-press-room/article/15147559/technogym-launches-skillmill-for-optimal-athletic-performance-training
- [28] Concept2 Holiday Challenge rules. https://log.concept2.com/challenges/holiday
- [29] c2forum thread, BikeErg vs RowErg distance and energy. https://c2forum.com/viewtopic.php?p=551506
- [30] Concept2 calorie calculator. https://www.concept2.com/training/calorie-calculator

HYROX-affiliated and HYROX coaching sources

- [2] Rox Lyfe (Greg Williams), HYROX Sled Push guide. https://roxlyfe.com/how-to-crush-the-sled-push-at-hyrox/
- [3] Rox Lyfe, HYROX Sled Pull guide. https://roxlyfe.com/hyrox-sled-pull-guide/
- [4] Rox Lyfe, HYROX SkiErg guide (no substitutes given). https://roxlyfe.com/hyrox-skierg-guide/
- [5] Repz, HYROX sled alternatives. https://www.repz.app/sled-swaps
- [6] Repz, sled push substitutes. https://www.repz.app/blog/sled-push-substitute
- [7] Repz, SkiErg alternatives. https://www.repz.app/blog/skierg-alternatives
- [8] Repz named HYROX Official Online Training Partner (13 Aug 2026). https://www.observernewsonline.com/online_features/press_releases/repz-named-hyrox-official-online-training-partner-and-launches-its-app-worldwide/article_59c01c56-d2e4-5098-9aa5-28cba44ed97c.html and https://hyrox.com/training-partner/repz/
- [9] THETA, How do you train the sled push without a sled? https://thetaclo.com/blogs/hyrox-intel/how-do-you-train-the-sled-push-without-a-sled
- [10] Hybrid Pro Coach, HYROX equipment alternatives (no named author; states lunges as 200 m in error). https://hybridprocoach.com/blogs/hyrox/hyrox-equipment-alternatives
- [11] Fit Viz (Geoffrey, Kratos Studios lead coach), HYROX exercises and substitutes. https://www.fitvizpro.com/hyrox/exercises
- [12] HyroxVault, train for HYROX at home. https://www.hyroxvault.com/blog/hyrox-train-at-home/
- [13] RH Training Club, HYROX without a gym. https://hyrox.rhtrainingclub.com/?p=104
- [14] Hello Hyrox, sled pull without a sled. https://hellohyrox.com/2025/01/21/train-for-hyrox-sled-pull-even-without-a-sled/
- [15] Centr (HYROX equipment supplier), beginner workout vs alternatives. https://centr.com/blogs/thewarmup/hyrox-beginner-workout-vs-alternatives-which-is-right-for-you
- [40] HYROX partner page, Relentless. https://hyrox.com/training-partner/relentless-hyrox-program/
- [41] HYROX online training partners (DACH). https://hyroxdach.com/de/hyrox-online-training-partners
- [44] Race carpet vs gym turf friction reports. https://fitnessexperiment.co/hyrox-turf/ and https://barbend.com/sled-turf-issues-2025-hyrox-world-championships
- [48] RH Training Club, HYROX Starter minimal equipment. https://hyrox.rhtrainingclub.com/?p=2066

General strength and conditioning

- [16] BarBend (Mike Dewar, CSCS), sled push alternatives. https://barbend.com/sled-push-alternatives
- [31] Invictus Cardio Machine Conversion Chart (Nichole Kribs, 2024). https://invictusfitness.com/blog/invictus-conversion-chart/
- [32] CrossFit Invictus Q&A (Michele Vieux), ideas when you can't get a cardio machine. https://crossfitinvictus.com/?p=92947
- [42] Powerlifting Technique, wall ball alternatives. https://powerliftingtechnique.com/wall-ball-alternative/
- [46] Gym Mikolo, training HYROX with a power rack. https://gym-mikolo.com/blogs/guides/can-you-train-hyrox-with-just-a-power-rack

Gyms, vendors and apps (equipment lists)

- [36] OriGym, how to become a HYROX partner gym (updated 24 Apr 2026). https://www.origym.co.uk/blog/hyrox-partner-gym/
- [37] HYROX365, HYROX Training Club. https://www.hyrox365.com/affiliation/hyrox-training-club
- [38] REP Fitness, hybrid training equipment FAQ. https://repfitness.com/collections/hyrox-equipment
- [39] FitnessVolt, HYROX home gym equipment guide. https://fitnessvolt.com/roxrace/equipment/
- [45] RoxHype app listing. https://apps.apple.com/in/app/id6749751506
