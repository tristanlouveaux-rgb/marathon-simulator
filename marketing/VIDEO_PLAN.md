# Mosaic — Talking-Head Video Series: Full Production Specs

> Format: founder talking to camera, cut with phone screen-records. Primary channels: TikTok + Instagram Reels.
> Production pipeline: `docs/MARKETING.md` → Production Sequence (these specs are step 1+2 of that pipeline).
> Carousel pairings reference `marketing/carousel-*.html`.

## Series rules (apply to every video)

- **Cold open mid-story.** No "hey guys, today I want to talk about". Frame one is the hook line.
- **Hook is spoken AND written.** On-screen text restates the hook in frame one (majority watch muted first).
- **One number per video.** The number is what gets remembered and commented on.
- **Phone screen within 10 seconds.** Talking head builds trust, UI is the proof. Cut between them every 5–8s.
- **End on comment bait, not a download CTA.** Comments are the ranking signal pre-launch.
- **Series sign-off line: "A plan that looks after you."** Official brand tagline (adopted 2026-06-09). Use as the recurring closing beat across videos where it fits, and as a candidate App Store / landing headline. It can follow the comment bait or replace it on brand-led pieces.
- **Length target: 45–75s.** Hook 0–3s, setup 3–15s, demo 15–50s, land 50–65s, bait 65–75s.
- **A/B hooks**: each video has 3 hook options. Post the same body with different hooks as separate uploads a week apart; keep the winner's framing for the follow-up video.
- **Fact-check pass before filming**: every spec has a "verify before filming" list. Quote no number you haven't re-checked in the code that morning.

---

## Video 1 — Readiness: "Should I train today?"

**Goal**: establish credibility on the science. Broadest entry point; ship first.

### Hooks (A/B/C)
- A: "Your watch gives you a readiness score and refuses to tell you what's in it. I built one with exactly four signals, and I'll show you all of them."
- B: "There are three things that should be able to veto your training day no matter how good you feel. Here they are."
- C: "My app knows my legs are trashed even when my heart rate says I'm fine. Here's how." *(most relatable; predicted winner)*

On-screen text frame 1: "4 signals. 3 vetoes. 0 black boxes."

### Beat sheet
1. (0–3s) Hook.
2. (3–12s) The question the ring answers: should I do today's planned workout as-is. Four labels: Ready to Push / On Track / Manage Load / Ease Back.
3. (12–25s) The four signals, fast: Freshness (fitness minus fatigue), Load safety (last 7 days vs last 42), Momentum (fitness rising or decaying), Recovery (HRV + last night + 7-night history, resting HR as a veto).
4. (25–35s) Personal, not population: HRV judged against YOUR 28-day baseline. Resting HR only intervenes at 2 standard deviations above YOUR normal.
5. (35–48s) The floors: some things can't be averaged away. Load ratio over 1.5 caps the day at Ease Back regardless of sleep. Trashed legs from yesterday's session cap it even when aerobic load is fine; leg damage decays on its own ~48h half-life, separate ledger from cardio.
6. (48–58s) It learns YOUR recovery speed: compares how long your HRV/RHR actually take to return to baseline vs expected, tunes a personal recovery constant.
7. (58–68s) It acts: score under 60 → Adjust button → skip / downgrade / shorten, and the plan card actually changes.
8. (68–75s) Comment bait.

### Screen-record shot list
1. Home: tap readiness ring → readiness page (composite ring animates in).
2. Tap Freshness card → TSB drill-down chart.
3. Tap Leg Fatigue card → decay timeline with threshold zones.
4. Back to Home → Adjust button → accept downgrade → plan card visibly changes.

### Numbers to quote
4 signals · 28-day personal baseline · 48-hour leg half-life · floor at load ratio 1.5.

### Comment bait
"Which signal do you ignore the most? Be honest."

### Carousel pairing
`carousel-recovery.html` (post 2–3 days after).

### Verify before filming
- Sub-signal weights and floor thresholds in `src/calculations/readiness.ts` (ACWR caps, sleep caps, leg-load caps at 20/60).
- Adjust button flow on device (readiness ≤ 59 path).

### Traps
Do NOT tour all the readiness cards. Ring + two drill-downs + Adjust. Cut everything else.

---

## Video 2 — The plan that actually listens

**Goal**: differentiate from static-plan apps (Runna, PDF plans, coach templates).

### Hooks (A/B/C)
- A: "Training plans come in two flavours: too easy and too hard. That's because they're written before the app knows anything about you." *(the "two flavours" line — predicted winner)*
- B: "I rated every run 'too easy' for three weeks. My old training app did absolutely nothing with that. So I built one that listens."
- C: "You know that button where you rate how hard the workout felt? In most apps it goes nowhere. In mine it rewrites next week."

On-screen text frame 1: "Too easy. Too hard. Never right. Here's why."

### Beat sheet
1. (0–4s) Hook.
2. (4–15s) The premise: a day-one plan is a guess. The question is whether the app updates the guess.
3. (15–30s) Every session becomes data: effort rating vs prescribed, HR vs target zones, pace adherence, watts on the bike, reps-in-reserve in the gym.
4. (30–42s) What the data does: rated harder than planned for two weeks → next week's volume compresses (clamped ±15%). Load spiking past ~1.3× your chronic norm → hard sessions soften before you get hurt.
5. (42–54s) Benchmarks update themselves: threshold pace, FTP, swim speed refresh from ordinary training with a plausibility gate so one garbage watch reading can't poison your zones. House rule: a manually entered benchmark is a snapshot, not a ceiling.
6. (54–66s) The Sunday debrief: what you did vs planned, recovery trend, and next week side-by-side standard vs adjusted, a reason on every change. You accept it; it never rewrites behind your back.
7. (66–72s) Land: "Nothing changes without a reason attached. Nothing big changes without you saying yes. That's the contract."
8. (72–78s) Comment bait.

### Screen-record shot list
1. Post-run rating flow (RPE tap).
2. Plan view: next week's durations visibly different, with the change badge.
3. Toast/caption of a benchmark auto-bump ("Updated from your runs").
4. Week debrief step 3: side-by-side comparison with change reasons. **Money shot — hold 4+ seconds.**

### Numbers to quote
±15% weekly clamp · 1.3× load-ratio trigger · 2-week trailing window.

### Comment bait
"Has a plan ever told you to do something that made zero sense that week? Story time in the comments."

### Carousel pairing
`carousel-easy-run.html` or `carousel-marathon.html` (plan-rebalancing slides).

### Verify before filming
- Effort multiplier clamp values in `src/workouts/plan_engine.ts` / `effort-multiplier.triathlon.ts`.
- ACWR thresholds used by the plan engine (1.3 / 1.5).
- Debrief step 3 renders the comparison on current build.

---

## Video 3 — The founder story — FILMED 2026-06-09

**STATUS: SHOT.** Tristan filmed this but repitched the hook as a question: **"Can you train for a marathon while playing other sports?"** (broader, searchable, search-intent framing — good call). The tendonitis story is the body; the question is the frame. This means the natural next video is the PAYOFF — "here's how it actually counts your sports" (see Video 3B below).

**Goal**: THE cold-open positioning video AND the origin story (these are one and the same — see note below). Mosaic = the only plan that absorbs your other sports. This is the series opener; ship first.

**REAL STORY (locked 2026-06-08, Tristan's own account):** Trained for the London Marathon last year on a traditional plan. Plays a lot of other sport (touch rugby etc.) — Strava was already full. Didn't want to give up the sport, so stacked the plan ON TOP of existing activity. Too much leg load. Faced the dilemma: stop the sports he loves, or skip the workouts he paid for. Pushed through, got bad tendonitis, ran the marathon **held together by tape** (the photo exists — use it), well off his potential. That injury is what inspired the adaptive cross-sport app. NOTE: an earlier draft called this an "ACL tear" — that was a misspeak; it was **tendonitis from overload**, not a knee tear. The injury and the feature are ONE story, not a two-parter.

### Hooks (A/B/C) — Tristan dislikes gimmicky hooks; these are curiosity/honest-register, not bait
- A: "Why did the London Marathon almost give me permanent tendonitis?" *(curiosity hook, his own — predicted winner)*
- B: "This is my Strava from when I trained for London. It's also why I got injured." *(leads with the real artifact)*
- C: "I paid for a marathon plan and it almost wrecked my legs. Not because it was bad — because it knew nothing about the rest of my life."

On-screen text frame 1: matches the spoken hook. Cut to the tape photo on the word "tendonitis."

### Drafted script (tightened from Tristan's off-the-cuff take, 2026-06-08, ~45s)
> **[Hook, to camera]** "Why did the London Marathon almost give me permanent tendonitis?
> Last year I signed up, I was buzzing for it, and I got into one of the traditional training apps. The problem is I play a lot of other sport. **[cut to Strava]** My Strava looks like this. And I didn't want to give that up to train for a marathon, so I just added the plan on top of everything I was already doing.
> That's way too much load. My legs went almost immediately. And I was stuck with a choice: stop playing the sports I love, or skip the workouts I'd paid for. I didn't want either, so I pushed through, and I got bad tendonitis. **[cut to tape photo]** I ran it, but held together by tape, nowhere near what I could have.
> But it got me thinking. There should be an app that counts everything you do. It knows how long you played and how hard, it knows rugby loads your legs harder than a steady run, and it knocks that off what's coming. So instead of a 30K the day after rugby, maybe it's 20. Or it looks at how your legs are actually doing and says: today, just go easier.
> **[to camera]** I just wanted a plan that adapted to what I could actually do. So I'm building it. What sport would you want it to count?"

**Decision (Tristan, 2026-06-08): this video is STORY-ONLY.** Do not explain the load engine (TSS, iTRIMP, conversions) here — it kills the emotional thread. The mechanics ("what's a game of padel worth in running terms — here's the maths") become their OWN follow-up video, seeded by this one's comment bait. Keep the worked TSS example and the Keep/Reduce/Replace modal demo for that follow-up (was the old V3 body; now lives in the load-currency mechanics video).

### Non-negotiable accuracy fixes (verified against code 2026-06-08)
- **DO NOT say the app measures "change of direction" or "distance covered" per session.** It does not. `universalLoad.ts` reads heart-rate stream (iTRIMP), Garmin load, HR zones, duration, RPE, and a per-SPORT leg-load factor. There is no GPS-direction / cutting analysis.
- **Truthful phrasing**: "it knows a sport like rugby, with all the stopping and cutting, loads your legs harder than steady running." True at the category level (that's the design rationale for rugby's higher per-sport factor) — NOT a per-session measurement claim.

### Screen-record shot list
1. The real Strava feed (cluttered, multi-sport) — the artifact.
2. The tape / finish-line photo.
3. (light) Plan view showing a run reduced after a logged sport — just enough to prove the promise, not a mechanics tour.

### Numbers to quote
"30K → 20K" (the relatable swap) · "two hours of rugby". Keep it to one or two; save TSS numbers for the mechanics video.

### Comment bait
"What sport would you want it to count?" → every reply is a future short where you do the maths. Content engine.

### Carousel pairing
`carousel-all-counts.html`.

### Verify before filming
- Confirm the tape photo is available and usable.
- Confirm a plan-reduction-after-logged-sport state can be shown on device.
- Re-read the accuracy fixes above — the change-of-direction line is the one real trap.

---

## Video 3B — The payoff: "So what's a game of rugby actually worth?" — NEXT TO FILM

**Goal**: directly answer the question Video 3 posed ("can you train for a marathon while playing other sports?"). Video 3 = the problem + the promise. 3B = the proof. Show the app genuinely measuring a real sport and knocking it off the plan. This is the demo video; it converts curiosity into "wait, it actually does that?"

### Hooks (A/B/C) — honest register, no gimmick
- A: "Last video I asked if you can train for a marathon while playing other sport. Here's the part that makes it work: what a game of rugby is actually worth." *(direct sequel — predicted winner)*
- B: "I played 90 minutes of rugby. Watch what my training plan did with it." *(curiosity + real data)*
- C: "Most apps log your rugby as a workout and move on. Mine works out what it cost your legs and changes tomorrow's run."

On-screen text frame 1: matches the spoken hook. Cut to the real logged rugby session on screen fast.

### The honest framing (this is the whole video)
Every other app treats your other sport as a tick in a calendar. Mosaic asks three questions about it that actually matter:
1. **How hard was it, really?** Measured from heart rate + duration, not a guess.
2. **What did it cost your legs?** Rugby's stop-start beats your legs up harder than steady running — the app knows that and gives rugby **30% more recovery time** than a normal session.
3. **How much of it counts toward running fitness?** Rugby keeps your engine going but it isn't running, so only part of it transfers. The app credits the part that counts and adjusts the plan around the rest.

### Beat sheet (~50s)
1. (0–6s) Hook + callback to V3.
2. (6–16s) The problem restated, fast: other apps log the sport and do nothing. The plan stays the same, so you end up doing both — which is exactly how I got hurt.
3. (16–30s) **[screen-record]** Log a REAL rugby session. Show the actual credit number the app produces. "90 minutes of rugby — the app reckons that's worth [REAL NUMBER from device] off my week."
4. (30–42s) The clever bits, spoken over the UI: it knows rugby costs your legs more (30% longer recovery), and it knows rugby can't replace your long run — that session is protected. So it trims the easy stuff, not the important stuff.
5. (42–52s) **[screen-record]** The plan visibly changes: tomorrow's run drops or eases. "So instead of running into the ground, I do a bit less, and I'm still on track."
6. (52–58s) Land: "That's the difference between an app that tracks your life and one that adapts to it." Comment bait.

### Screen-record shot list
1. The real rugby session logged, showing the credit it produces. **Money shot — this is the proof. Use real data.**
2. The Keep / Reduce / Replace modal (if it fires) with the arithmetic.
3. Plan view before/after: the adjusted run with its badge.
4. (optional) Weekly load showing the sport split.

### Numbers — VERIFIED against code 2026-06-09 (safe to say on camera)
- Easy run ≈ **55 TSS/hour**; 1 hour at threshold = **100 TSS** (the anchor).
- Rugby systemic-load multiplier = **1.5×** (`rugby: mult: 1.50`).
- Rugby recovery = **30% longer** than a normal session (`recoveryMult: 1.30`).
- Rugby is **protected from replacing the long run** (`noReplace: ['long']`).
- Rugby only **partially transfers** to running fitness (`volumeTransfer: 0.70`).
- Contrast: cycling mult 0.75, swimming 0.65, padel 1.15.
- **HEADLINE NUMBER ("90 min rugby = X off your week"): DO NOT fabricate. Log a real session on device and screen-record the actual credit.** It's more accurate AND more authentic.

### Comment bait
"Tell me your sport and I'll work out what it's worth — football, padel, CrossFit, whatever. Drop it below." *(content engine: every reply is a future short.)*

### Carousel pairing
`carousel-all-counts.html`.

### Verify before filming
- Re-confirm the numbers above haven't changed in `src/constants/sports.ts` (the file is shared/multi-agent — values can move).
- Log a real rugby (or other sport) session on device and confirm the credit + plan adjustment renders. The video depends on this state existing.
- **Accuracy trap (same as V3):** do NOT say it reads "change of direction" or "distance / GPS" per session. It reads HR/iTRIMP, Garmin load, HR zones, duration, RPE, and a per-sport factor. The stop-start framing is the design RATIONALE for rugby's numbers, not a per-session measurement.

### Traps
- Keep the 8-scales bug story OUT (separate dev-log video).
- Resist explaining all four data tiers (iTRIMP / Garmin / zones / RPE). "Measured from your heart rate and duration" is enough. The tier detail is a different, nerdier video.
- One number on screen at a time. This video is already number-dense; let each land.

---

## Video 4 — Injury mode: "An injured body part isn't an injured body"

**Goal**: the emotional anchor of the feature set. Standalone injury-mode video. Personal intro hook = the same tendonitis layoff from V3 (the weeks it knocked him out), but this video is about the FEATURE, not a second injury. NOTE: there is no ACL story — earlier draft was a misspeak; the founder injury was tendonitis and is told in V3.

### Hooks (A/B/C)
- A: "When the tendonitis knocked me out, every training app gave me the same plan: nothing. Greyed-out calendar, see you in six weeks. I thought that was insane." *(ties to V3, honest register — predicted winner)*
- B: "An injured knee doesn't mean an injured body. My physio knew that. My training app didn't."
- C: "Most apps treat injury as an on/off switch. You're either training or you're not. Bodies don't work like that."

On-screen text frame 1: "Injured ≠ done. [greyed-out calendar graphic]"

> **TRISTAN TO FILL IN**: the real tendonitis layoff specifics — how many weeks off, what you could/couldn't do, whether you kept training around it. Ties this video back to V3's story.

### Beat sheet
1. (0–6s) Hook + light callback to V3: "After the tendonitis from the last video, I was knocked out for weeks — and no app had any idea what to do with me except stop."
2. (6–18s) The point: what every app did with an injury — nothing. Training apps model you as either healthy or invisible.
3. (18–30s) What injury actually is: capacity, not a switch. In Mosaic you set sliders per discipline. A 60% knee does 60% of run volume, not zero. Bike, swim, upper body each get their own number.
4. (30–42s) Region-aware strength: the knee is out, nothing else is. Exercises loading the injured area are filtered out; everything else continues at controlled effort. Relative rest is local, not total.
5. (42–54s) The road back is IN the plan: capacity-test sessions appear as actual workouts (hop test, single-leg work), then walk/jog intervals that progress off your morning pain taps. Pain spikes → it steps back a level. No guesswork, no bravado.
6. (54–64s) The honest ring: the app never pretended I was unfit. Sleep good, fatigue low → readiness high, AND running blocked. Both true, shown separately. Fitness and permission are different things.
7. (64–70s) Coda, fast: same thinking covers getting sick (above/below the neck rule, graded return) and going on holiday (it knows your shoes travel and your bike doesn't). One sentence each, no more.
8. (70–78s) Land: "I built this because I needed it and it didn't exist." Comment bait.

### Screen-record shot list
1. Injury modal: type selection → capacity sliders moving. **Money shot.**
2. Plan view with injury banner: phase, pain buttons (Better / Worse), capacity pills.
3. A capacity-test session and a walk/jog session sitting in the plan as real workouts.
4. Readiness ring high while run shows blocked (the two-truths shot).

### Numbers to quote
ONE: "60% knee does 60% of the volume". Plus the personal timeline numbers.

### Comment bait
"What's the worst advice an app or a plan gave you while injured? I'll go first: mine said nothing at all."

### Carousel pairing
None existing — consider building `carousel-injury.html` after this video ships (slide 2 hook: "An injured knee doesn't mean an injured body").

### Verify before filming
- Capacity slider behaviour and defaults in `src/injury/engine.ts` / `src/ui/injury/modal.ts`.
- Capacity tests + walk/jog sessions actually injected into the plan on current build.
- Illness neck rule + holiday logic one-liners (`src/calculations/illness-rules.ts`, `src/ui/holiday-modal.ts`).

### Traps
- Do not let illness/holiday grow past one sentence each. If they're interesting, they earn their own video later.
- Do not perform the injury as tragedy. Consultant tone: this happened, it was preventable, here's the system.

---

## Video 5 — Running should be fun (flexibility + Run by Feel)

**Goal**: warmth video. Counters the "another data prison" objection. Talking-head version of the "Sorry, can't" ad concept.

### Hooks (A/B/C)
- A: "Hot take from someone who built a training app: the plan is not the point."
- B: "If you're not feeling today's run, change it. Tap, easier, shorter, done. The app re-plans the rest of the week around what you actually did." *(predicted winner)*
- C: "My app has a workout where it tells you nothing. No pace, no target, no judgement. It's called Run by Feel and it's the feature I'm proudest of."

On-screen text frame 1: "The plan is not the point."

### Beat sheet
1. (0–4s) Hook.
2. (4–14s) The problem: plans turn running into homework. Miss a Tuesday and the week is "ruined", so people quit the plan or quit running.
3. (14–28s) Adjust anything: every session has Easier / Shorter / Move. Step the intensity down and the target paces rewrite themselves; the description never lies to you.
4. (28–40s) The honest tradeoff, with numbers: does adjusting affect your race forecast? Yes, and the app shows you exactly how much instead of guilting you. A single skipped Tuesday costs you almost nothing, and the app will prove that with the forecast delta.
5. (40–52s) Run by Feel: a session where the app deliberately shuts up. No pace, no splits, no judgement. Training the skill your watch trained out of you. *(Personal PB anecdote here if telling it.)*
6. (52–64s) The system absorbs it either way: whatever you actually did gets measured and next week adapts. There is no "off plan". There's just what you did.
7. (64–72s) Land: "Consistency beats compliance. An app should make the next run more likely, not the missed one feel worse." Comment bait.

### Screen-record shot list
1. Workout card → Adjust → intensity steps down → paces visibly rewrite. **Money shot.**
2. Forecast before/after a skip: the tiny delta (this is the proof of "costs almost nothing").
3. Run by Feel session card (the absence of targets is the visual).

### Numbers to quote
The forecast delta of one skipped easy run (pull the real number from the app, it will be seconds).

### Comment bait
"What's the longest you've stuck to a plan before life broke it? I give most people three weeks."

### Carousel pairing
`carousel-easy-run.html`.

### Verify before filming
- Pace retargeting on intensity step (`src/workouts/workout-scaling.ts`) on device.
- An actual forecast delta from skipping one easy session (don't estimate it on camera, show it).
- Run by Feel session spec (`docs/FEATURES.md`).

---

## Video 6 — The taper: "Watch yourself get faster by doing less"

**Goal**: NOT "we have a taper" (every app schedules one). The angle: **Mosaic quantifies the taper live**. Fatigue is a number that decays in front of you, and the race forecast improves as it clears. The taper becomes something you can watch, not something you endure.

### Hooks (A/B/C)
- A: "For the last two weeks before your race, my app shows you a number going down. That number is your fatigue, and watching it fall is the only thing that stops you from sabotaging your taper." *(predicted winner)*
- B: "Doing less made my predicted race time faster, and I could watch it happen. Day by day. Here's the maths of a taper."
- C: "Taper week is when fit runners ruin their race. Not from undertraining. From panic. Here's the chart that cures it."

On-screen text frame 1: "Fitness: holding. Fatigue: draining. Watch."

### Beat sheet
1. (0–5s) Hook.
2. (5–16s) The psychology problem: taper restlessness is universal. Volume drops 30 to 50%, you feel like you're losing fitness, so you add sessions and arrive at the start line tired. Every coach knows this; apps do nothing about it.
3. (16–30s) The model on screen: training creates fatigue that sits ON TOP of fitness. During taper, fatigue clears while fitness holds. Fitness does not decline over a 2 to 3 week taper. It consolidates. (This copy is verbatim in the app — quote it.)
4. (30–42s) The differentiator, part 1: fatigue is a live number, not a vibe. Overdid last week by 100 TSS? Monday still carries ~61 of it; by Friday it's ~35. The app shows residual fatigue decaying day by day.
5. (42–54s) The differentiator, part 2: the forecast moves. Race-day readiness is a term in the prediction, so as fatigue drains across taper week, your predicted time improves on screen. You're not trusting the taper, you're watching it pay.
6. (54–64s) Triathlon kicker: tapering for a tri is a three-body problem. Swim, bike and run fitness fade at different speeds, so each discipline tapers on its own schedule. The app sequences all three to peak together on race morning.
7. (64–72s) Land with the number: a proper 2 to 3 week taper makes recreational runners 2 to 3% faster. On a 4-hour marathon that's 5 to 7 minutes, for doing less. Comment bait.

### Screen-record shot list
1. Load & Taper view: phase timeline ending in the green taper block.
2. The "why taper works" panel + fitness-vs-fatigue separation chart. **Money shot — hold it.**
3. Race forecast across taper: the prediction improving (record on consecutive days if possible, or use the readiness stage in the forecast breakdown).
4. Tri mode: per-discipline fitness rings during taper week.

### Numbers to quote
30–50% volume drop · 100 TSS excess → ~61 Monday → ~35 Friday · 2 to 3% faster = 5 to 7 minutes on a 4-hour marathon.

### Comment bait
"Have you ever added a workout during taper week because you panicked? Confess."

### Carousel pairing
`carousel-marathon.html` (forecast slides) or build a dedicated taper carousel from the fitness/fatigue chart.

### Verify before filming
- Residual fatigue numbers (61/35) and taper copy in `src/ui/load-taper-view.ts:260-307`.
- Race-day readiness term in tri/HYROX predictions (`src/calculations/race-prediction.triathlon.ts`, `race-projection.hyrox.ts`) — confirm the running forecast's equivalent before claiming it for running mode; if it's tri/HYROX only, say "in triathlon mode" honestly.
- The 2–3% taper claim source (SCIENCE_LOG, Bosquet 2007 meta-analysis is the standard citation).

### Traps
- Never frame as "we have a taper feature". The entire video is the LIVE NUMBER and the MOVING FORECAST.
- The 2–3% claim must stay "recreational runners, proper 2 to 3 week taper" — don't inflate.

---

## NEW CONCEPTS (Tristan, 2026-06-09) — verified, ready to slot

### Concept A — "Why are most running plans not adaptive?" (replaces/upgrades V2)
**Verified**: athlete typing is real. `getRunnerType(b)` in `fatigue.ts:55` classifies Speed / Balanced / Endurance from the Riegel fade exponent (how much you slow as distance grows), derived from how you actually race — NOT just your entry 5K time. Feeds plan generation AND forecasts.

Two root causes of non-adaptive plans (the video's spine):
1. **They only take your 5K time at signup, and never ask what KIND of athlete you are.** A footballer with top-end speed is built for tempo/threshold; a diesel engine is built for volume. Mosaic types you Speed/Balanced/Endurance from how you fade over distance and shapes the plan to match.
2. **They never update from how your runs actually went** — your heart rate, how hard each run felt. Mosaic reads every run and adjusts, so the plan tracks how you're actually responding.

- Hook A: "Why is your running plan the same as everyone else's? Because it only knows one thing about you: your 5K time."
- Hook B: "There are two kinds of runner: built for speed, and built for endurance. Your training plan probably doesn't know which one you are. Mine does."
- Thesis line: "A plan should understand you as an athlete, and it should get easier or harder based on how you're actually doing."
- Accuracy note: types are Speed (fade exponent b > 1.12), Endurance (b < 1.06), Balanced (between). Derived from race/fade data via Riegel. Don't claim it reads "what sport you play" directly — it infers type from your running fade pattern; the football example is an analogy for the SPEED type, not a literal input.
- This supersedes the old V2 framing. Keep V2's "every session becomes data" body as the second half (cause #2).

### Concept B — The readiness score (this IS V1; use this framing)
Tristan's ask: make the seven factors user-friendly. SOLUTION — don't name seven jargon terms; group them into THREE questions. Full wording table + grouping below; lift verbatim into the V1 script.

**The seven, renamed:** Freshness ("fitness banked minus the tiredness it cost") · Load ratio → "are you ramping too fast?" · Rolling load → "your recent workload" · Strain → "today's effort" · Physiology → "overnight signals (HRV + resting HR)" · Sleep → "last night's sleep" · Leg fatigue → "how beat up your legs are (tracked separately)".

**The grouping (video spine):**
1. "How much have you been training?" → freshness, recent workload, ramping-too-fast, today's effort (all load, different time zooms).
2. "What is your body telling you?" → overnight signals + last night's sleep.
3. "How are your legs?" → leg fatigue (separate, because impact damage ≠ general tiredness).

Payoff line: "Most apps look at one of these. We built the score that looks at all of them, because any one of them can be the reason you shouldn't push today."
- Hook: "What actually decides whether you should train hard today? It's not one thing. I count seven, and I'll show you all of them in three buckets."
- Replaces the old V1 hook framing; keeps the V1 shot list (ring → drill-downs → Adjust).

### Concept C — "Why is there no good HYROX app?" (walkthrough of Mosaic's HYROX mode)
**Goal**: provocation hook + a genuine walkthrough of the HYROX mode, the deepest mode in the app. (NOTE: earlier draft mis-transcribed this as "high-VO2" — it's HYROX.)

**Verified facts (2026-06-09, safe on camera):**
- **89,868 real finisher rows** ingested (Kaggle `jgug05/hyrox-results`, Seasons 4–6; `hyrox-population-distributions.ts:52`). Forecast places you in the REAL field.
- **MTL — MusculoTendon Load**: tendon-specific load model with its own decay, separate from cardio (`race-prediction.hyrox.ts`). The differentiator — HYROX destroys tendons (sleds, lunges, wall balls) and the app tracks that, not just heart rate.
- **Forecast splits the race into three parts**: the 8 runs, the 8 stations, and the **roxzone** (transitions / running between stations) — `race-projection.hyrox.ts:68` (stations + roxzone byDiscipline). The roxzone is the time-sink nobody models.
- Per-station injury blocking via station→region map; station-by-station forecast; performance radar vs cohort.
- Screen-record surfaces: `forecast-view`, `percentile-distributions`, `performance-radar`, `station-detail-view`, `plan-view` (run/station/brick mix).
- HYROX format (public knowledge, not an app claim): 8×1km runs alternating with 8 stations (SkiErg, Sled Push, Sled Pull, Burpee Broad Jumps, Row, Farmers Carry, Sandbag Lunges, Wall Balls).

**THE REAL SELL (Tristan, 2026-06-09):** not a feature list — the ENGINE PIVOT. "I didn't build a HYROX app. I built one adaptive engine and taught it the physics of each sport." Lead with why HYROX is genuinely HARD (the depth), show the system solving that specific hardness, land the engine-pivot as proof it's not a one-trick app.

**Why HYROX is hard (the depth — this is the setup):**
- It asks you to be TWO athletes at once: a runner AND a power athlete, and those adaptations interfere (concurrent-training effect — too much strength blunts running, too much running leaves nothing for the sled).
- Your time is gated by your WEAKEST station, not your average fitness.
- The running is compromised running — 8×1km already fatigued, into and out of stations. Not fresh 8km.
- The limiter and injury risk is tendon/musculoskeletal load, not lungs.

**Hooks (honest register):**
- A: "HYROX might be the hardest thing to train for, and I couldn't find one app that did it properly. So I built it. Let me show you why it's so hard." *(why-hard lead — predicted winner)*
- B: "I didn't build a HYROX app. I built one training engine and taught it the physics of every sport. HYROX is where that pays off the most."
- C: "Your HYROX time isn't set by your fitness. It's set by your weakest station and the running between them that nobody trains."

**DRAFTED SCRIPT (~75s — engine-pivot reframe):**
> **[Hook, to camera]** "HYROX might be the hardest thing there is to train for, and I couldn't find a single app that did it properly. So I built one. Let me tell you why it's so hard.
> **[1, why-hard]** HYROX asks you to be two athletes at once. A runner, and a power athlete. And those two things fight each other. Train too much strength and your running falls apart. Too much running and you've got nothing left for the sled. On top of that, your time isn't set by your average fitness. It's set by your single worst station, and the running between them that nobody trains for.
> **[2, the engine]** So here's what I did. I took the adaptive engine I'd already built for marathon training, the one that periodises your weeks and balances your load, and I taught it the physics of HYROX. **[cut to MTL chart]** It tracks the load on your tendons separately, because in HYROX that's what actually breaks. **[cut to forecast]** It forecasts every run, every station, and the transitions between them. **[cut to percentile/radar]** And it places you against nearly 90,000 real finishers, so your target isn't a guess, it's where you actually land in the field.
> **[3, the pivot — the real sell]** And this is the part I'm proud of. It's the exact same engine that runs my marathon block and my triathlon. I didn't build three apps. I built one brain that understands training, and taught it the physics of each sport.
> **[to camera]** That's the HYROX app I wanted and couldn't find. What's your weakest station? Mine's the sled pull."

### Numbers to quote
89,868 real finishers · 8 runs + 8 stations · MTL (musculotendon load) · the three-way race split (runs / stations / roxzone).

### Comment bait
"What's your weakest station?" *(every HYROX athlete has a strong opinion — high-engagement, and it's niche-community catnip.)*

### Carousel pairing
`carousel-hyrox.html` (already exists — Run/Station/Brick mix, tendon-load decay chart, 16-row forecast).

### Verify before filming
- Re-confirm finisher count 89,868 in `hyrox-population-distributions.ts` (re-ingest could change it).
- Screen-record on device: HYROX forecast (run/station/roxzone split), the MTL decay chart, the percentile/radar vs cohort, and a plan week with run/station/brick.
- Confirm the roxzone/transition row is actually labelled in the forecast UI before naming it on camera.

### Backlog priority
Strong niche video — HYROX community is small, rabid, and underserved, so engagement-per-view will be high even if reach is narrower. Ship after the founder + rugby payoff land; pairs naturally with the existing `carousel-hyrox.html`.

### Concept D — Triathlon: "My app shows me two finish times" (forecast-potential hero + engine pivot)
**THE REAL SELL (Tristan, 2026-06-09):** (1) FORECAST POTENTIAL, (2) the engine pivot. Same depth structure as HYROX: why tri is hard → how the system solves it → the two-number forecast → the pivot.

**Verified (2026-06-09):**
- Forecast computes BOTH `currentTotalSec` ("if you raced today") AND the projected race-day time ("if you stick with the plan"). The GAP = forecast potential. This is the hero. (`race-prediction.triathlon.ts:27`)
- Three separate fitnesses: swimCtl / bikeCtl / runCtl, perDisciplineACWR (`tri-benchmarks-from-history.ts`, `tri-discipline-floor.ts`).
- Course factors: climate, altitude, elevation, wind, swim type/wetsuit (`applyCourseFactors`).
- Durability cap (bike + run; swim has none) — can you hold pace late (`durability-cap.ts`).
- Brick detection + adaptation — run-off-the-bike modelled (`brick-detector.ts`).

**Why triathlon is hard (the depth):** you're not peaking one sport, you're peaking THREE at once, and they interfere (a big bike day taxes your run). They lose fitness at different rates, so they don't taper together. And your finish time swings on things people ignore: hills, heat, wetsuit, and whether you can still run off the bike.

**Hooks:**
- A: "My triathlon app shows me two finish times. The one I'd get today, and the one I'll get on race day if I do the work. The gap is my potential." *(forecast-potential lead — predicted winner)*
- B: "Triathlon is three sports fighting each other. Here's the app that finally models the fight."
- C: "Your triathlon time isn't your swim plus your bike plus your run. Here's everything in between that actually decides it."

**DRAFTED SCRIPT (~75s):**
> **[Hook, to camera]** "My triathlon app shows me two finish times. The one I'd get if I raced today, and the one I'll get on race day if I actually do the work. The gap between them is my potential, and I get to watch the plan close it.
> **[why-hard]** Triathlon is brutal to train for, because you're not training one sport. You're peaking three at the same time, and they fight each other. A big bike day taxes your legs for the run. They lose fitness at different speeds, so they don't even taper the same way. And your finish time swings massively on stuff people ignore: the hills, the heat, whether there's a wetsuit, and whether you can still run after five hours on the bike.
> **[the system]** So the app treats your swim, bike and run as three separate engines, **[cut to per-discipline fitness]** each with its own fitness and freshness. It knows a hard ride costs your run. **[cut to course factors]** It factors the actual course: elevation, heat, the wetsuit. And it models your durability and your brick running, whether you can hold pace when it matters.
> **[forecast potential payoff]** **[cut to forecast]** All of that feeds one honest forecast. Not a vague finish time, a real one, with the gap between today and your potential laid out in front of you. Do the sessions, watch the number come down.
> **[pivot]** And it's the same engine that runs my marathon plan and my HYROX block. One brain, taught the physics of each race.
> **[to camera]** What's your weakest of the three? I'm a decent swimmer and a nervous runner."

### Numbers / facts to quote
Two-number forecast (today vs potential) · three separate fitnesses · course factors (elevation/heat/wetsuit) · durability + brick. No fabricated finish times — show your real forecast.

### Comment bait
"What's your weakest of the three — swim, bike, or run?"

### Carousel pairing
`carousel-ironman.html` (three-discipline plan, per-discipline rings, course-factor forecast — already built).

### Verify before filming
- Confirm the two-number (today vs race-day) forecast is visible together on one screen to show the gap.
- Screen-record: per-discipline fitness rings, course-factor breakdown, the forecast with the gap.

---

## CROSS-MODE ENGINE — the meta-narrative (use across A/HYROX/D)
The spine that ties the multi-sport videos together: **one adaptive engine (Banister impulse-response + canonical load currency + readiness + adaptive progression), re-skinned per sport with sport-specific physics on top.** The line: "I didn't build five apps. I built one brain that understands training, then taught it the physics of each sport." Use it as the landing beat in HYROX (C) and Tri (D); it's the credibility flex that makes the depth believable.

### Concept E — The engine: "How does one app do five sports?" (standalone meta-video)
**Goal**: the "how is this even possible" video for people who've seen the marathon / HYROX / tri pieces and wonder how one app does all three without being mediocre. Pure credibility/positioning. Ship AFTER at least two mode videos land, so the question already exists in viewers' heads.

**Verified facts:** five modes (running, triathlon, cycling, HYROX, just-track — `mode-audit`); Banister impulse-response engine (MARKETING.md positioning); canonical TSS load currency (one unit across all sports — Load Currency Law); readiness engine; "nothing resets" carried fitness across goals (`carousel-more-than-running.html`).

**Hooks:**
- A: "People ask how one app can train a marathon, a triathlon and a HYROX without being mediocre at all three. Here's the honest answer: I didn't build three apps." *(predicted winner)*
- B: "Most apps do one sport well and bolt the others on badly. I did it the other way around."
- C: "Switch from marathon to HYROX in most apps and your fitness history resets to zero. That always seemed insane to me."

**DRAFTED SCRIPT (~70s):**
> **[Hook, to camera]** "People ask how one app can train for a marathon, a triathlon, and a HYROX without being mediocre at all three. Here's the honest answer: I didn't build three apps. I built one engine.
> **[the engine]** Underneath all of it is the same brain. It learns your fitness from every session you do, using a model sports scientists have trusted for decades. It measures every kind of training — a run, a ride, a swim, a game of rugby — in one single currency, so nothing gets double-counted and nothing gets ignored. And every morning it works out one thing: how ready you are to push today.
> **[the sport physics]** That engine doesn't care what sport you do. So on top of it, I taught it the physics of each race. For the marathon, how you fade over distance. For triathlon, how three sports interfere, and how a course changes your time. For HYROX, how your tendons load, and how your weakest station decides your result.
> **[the payoff]** Same brain, different physics. That's why your fitness doesn't reset when you change goals. Run a marathon in spring and a HYROX in winter, and the engine carries everything it learned about you across.
> **[land]** One engine, taught to understand you, whatever you're training for. **[tagline]** A plan that looks after you."

### Numbers / facts to quote
One load currency across all sports · five modes · "nothing resets" carried fitness. No fabricated numbers — this is a concept video; lean on the idea, not figures.

### Comment bait
"What two sports would you want one plan to handle?" (or go straight to the tagline on this brand-led piece).

### Verify before filming
- Confirm "fitness carries across modes / nothing resets" is demonstrable on device (mode switch keeping CTL/benchmarks) before claiming it.

---

## BRAINSTORM — run-to-work, life-happens, "plan looks after you" (2026-06-09)

### Run to work → Friends episode + a beat in the adaptive video (NOT its own explainer)
- Real anchor: Tristan's friend ran to work; the amateur London Open winner ran to work. Strong human credibility.
- HONESTY: there's no dedicated "commute mode" — the app absorbs any logged run. So the claim is PHILOSOPHICAL, not a feature: "training isn't a separate chore you bolt onto life; it's the stuff you already do, counted properly."
- BEST HOME: a "Friends" series episode ("this feature exists because of my friend who ran to work"). ALSO drop it as a concrete example inside the adaptive video (Concept A) — "the app counts the running you're already doing, even your commute" — proves the it-all-counts thesis with a relatable image.
- Hook: "The guy who won the amateur London Open ran to work to train for it. My app is built for exactly that."

### Check-in / illness / injury → its own video ("life happens", = expanded V4)
- Through-line: the daily CHECK-IN is how the app stays in touch and catches trouble early; when you're sick or hurt it ADAPTS instead of abandoning you. Merges the check-in ritual + illness + injury into one emotionally relatable video.
- Lead with the universal moment: "You wake up feeling rough. Most plans don't care. Mine asks how you're doing, and changes the day."
- Keep V4's injury depth (capacity sliders, region-aware strength, graded return) as the back half; illness neck-rule as the front. This supersedes/absorbs the standalone V4 framing.

### "This plan looks after you" → likely the BRAND TAGLINE, optionally a protection video
- Pushback: as a feature-explainer this is too diffuse — it would just re-list readiness + adaptation + injury. Two stronger uses:
  1. **Tagline / series sign-off line.** "A plan that looks after you" is a genuinely good brand line — use it as the recurring closer across every video, and possibly the App Store / landing headline.
  2. **A standalone "protection" video** IF given a distinct angle: every other plan is indifferent and will happily run you into the ground; ours actively protects you — won't let you ramp too fast (load-ratio cap), backs off when you're tired (readiness), protects your long run (noReplace), reduces load when you're sick. Angle = SAFETY, not adaptation. "It's the only plan actively trying to keep you healthy, not just make you faster."
- Recommendation: adopt it as the tagline now; build the protection video later only if the safety angle stays distinct from the adaptive + life-happens videos.

**DRAFTED PROTECTION-VIDEO SCRIPT (~70s — the standalone "safety" angle, written 2026-06-09 at Tristan's request):**
All four protections below are VERIFIED real: load-ratio (ACWR) cap, readiness back-off, `noReplace:['long']` long-run protection, illness load reduction + graded return.
> **[Hook, to camera]** "Every training plan I'd ever used was perfectly happy to run me into the ground. They care about one thing: making you faster. So I built one that cares about something else first. Not breaking you.
> **[1, ramp]** It won't let you ramp up too fast. There's a hard limit on how much your training load can jump from one week to the next, because that spike is what gets people injured. It's exactly what got me.
> **[2, readiness]** If your sleep, your heart rate, or your fatigue say you haven't recovered, it backs the day off. It would rather you train a little less today than nothing at all next month.
> **[3, protect the key session]** It protects your long run. Play a game of football the day before, and it'll trim your easy sessions to make room, but it won't sacrifice the session that actually matters.
> **[4, illness]** And when you're ill, it doesn't just grey out the calendar. It drops your load, and walks you back up gradually when you're better.
> **[land]** Most apps make you faster and leave the staying-healthy part to you. A plan should do both. **[tagline]** A plan that looks after you."
- Hooks (if shot): A "Every plan I'd used was happy to run me into the ground." · B "Your training plan does not care if you get injured. Mine is built to stop it." · C "Most plans only care about making you faster. Mine cares about not breaking you first."
- TRAP: keep this distinct from the adaptive video (Concept A) and the life-happens video — the angle here is SAFETY/PROTECTION, not "it adapts". If it starts sounding like the adaptive video, cut it and keep "looks after you" as tagline only.

---

## Series 7 — "This feature exists because of my friend ___" (recurring format)

**Source**: Tristan's brain dump ("Friends – each app feature is based on a friend").

**Format**: 30–45s each. Hook template: "This feature exists because of my friend [name]." Then: the friend's behaviour → the failure mode in normal apps → the Mosaic feature → 5s demo.

**Episode backlog** (map real friends before filming):
| Friend archetype | Feature |
|---|---|
| The one who's always injured | Injury capacity mode |
| The one who plays five sports | Cross-sport replacement |
| The one who never sleeps | Sleep debt + readiness floors |
| The one who ignores every plan | Run by Feel / adjustability |
| The one who always goes too hard | Effort scoring pulling volume down |
| The one training for HYROX "for fun" | HYROX mode + 89k-finisher data |

**Why it works**: infinitely repeatable, humanises the product, every episode is a feature ad that doesn't feel like one, and friends can appear on camera (boosts reach vs solo head). Get verbal OK from each friend; use first names only.

---

## Backlog (next wave, after V1–V6 perform)

| Video | Angle | One number |
|---|---|---|
| Forecast waterfall | "Every second of your predicted time comes from somewhere" | the per-row deltas |
| "Faster than 87% of runners" | onboarding placement vs 35M results; HYROX vs 89,868 finishers | 35M |
| Watch trust | "Which of your watch's numbers I believe, and why" (corroborated max HR, LT plausibility gate) | 5 bpm witness rule |
| Strength makes you faster | gym work moves the race forecast (~3% economy ceiling) | 3% |
| Dev-log: the 8-scales bug | build-in-public confession; engineer audience | 8 scales |
| Illness mode solo | the neck rule + RHR override | 7-day rest |

## Release order

V3 (founder story — SHIP FIRST) → V4 (injury mode, posted ≤1 week after V3) → V5 (fun) → V1 (readiness) → V2 (adaptation) → V6 (taper) → Friends series begins.

Rationale (revised 2026-06-08): lead with the founder story (V3), not the science. `docs/MARKETING.md` always said the founder-injury concept is "the highest-leverage opener — ship it first"; the original V1-first ordering was pedagogical, wrong for a cold audience. V3 and V4 share the same injury (tendonitis), so keep them adjacent — V4 opens with a callback to V3 ("after the tendonitis from the last video..."). V5 warms the audience after the injury pair. V1 readiness is a depth/credibility video — it rewards an existing audience, so it moves later. V6 taper is evergreen; pin it to race seasons (spring/autumn marathon blocks) when taper anxiety peaks.
